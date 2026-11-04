// AMG Cloud Files host. OS-owned placeholders; no fake zero-byte substitute files.
#include <windows.h>
#include <winternl.h>
#include <cfapi.h>
#include <winioctl.h>
#include <sddl.h>
#include <shlobj.h>
#include <propkey.h>
#include <propvarutil.h>
#include <SearchAPI.h>
#include <winrt/Windows.Storage.h>
#include <winrt/Windows.Storage.Provider.h>
#include <winrt/Windows.Security.Cryptography.h>
#include <winrt/Windows.Storage.Streams.h>
#include <winrt/base.h>
#include <winrt/Windows.Data.Json.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Foundation.h>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <sstream>
#include <vector>
#include <map>
#include <mutex>
#include <thread>
#include <atomic>
#include <memory>
#include <algorithm>
#include <condition_variable>
#include "Version.h"

#define CF_SIZE_OF_OP_PARAM(name) (FIELD_OFFSET(CF_OPERATION_PARAMETERS,name)+sizeof(((CF_OPERATION_PARAMETERS*)nullptr)->name))

using namespace winrt::Windows::Data::Json;
namespace fs = std::filesystem;
static std::mutex outputMutex, requestsMutex, mutationMutex;
static std::atomic<unsigned long long> sequence{0};
static std::atomic<bool> stopping{false};
static std::atomic<bool> resetNoFetch{false},resetCanceled{false};
static std::wstring root, cacheRoot;
static std::string owner;
static CF_CONNECTION_KEY connection{};
static bool connected=false;
static thread_local std::string commandStage;
static GUID providerId={0xc687da5e,0xe057,0x4e99,{0x9a,0x1f,0x65,0xe6,0x60,0xf1,0x45,0x47}};
static const NTSTATUS failedStatus=static_cast<NTSTATUS>(0xC000CF12L); // STATUS_CLOUD_FILE_UNSUCCESSFUL
static const NTSTATUS deniedStatus=static_cast<NTSTATUS>(0xC0000022L);

static std::wstring ws(std::string const& s){return winrt::to_hstring(s).c_str();}
static std::string utf(std::wstring const& s){return winrt::to_string(s);}
static std::string str(JsonObject const& j,wchar_t const* key,std::string fallback=""){return j.HasKey(key)?winrt::to_string(j.GetNamedString(key)):fallback;}
static double num(JsonObject const& j,wchar_t const* key,double fallback=0){return j.HasKey(key)?j.GetNamedNumber(key):fallback;}
static bool jsonBool(JsonObject const& j,wchar_t const* key,bool fallback=false){return j.HasKey(key)?j.GetNamedBoolean(key):fallback;}
static void put(JsonObject& j,wchar_t const* key,std::string const& value){j.Insert(key,JsonValue::CreateStringValue(winrt::to_hstring(value)));}
static void putn(JsonObject& j,wchar_t const* key,double value){j.Insert(key,JsonValue::CreateNumberValue(value));}
static void putb(JsonObject& j,wchar_t const* key,bool value){j.Insert(key,JsonValue::CreateBooleanValue(value));}
static void emit(JsonObject const& j){std::lock_guard<std::mutex> lock(outputMutex);std::cout<<winrt::to_string(j.Stringify())<<std::endl;}
static void check(HRESULT hr){if(FAILED(hr))winrt::throw_hresult(hr);}
static void wincheck(bool ok){if(!ok)winrt::throw_last_error();}
static std::wstring lower(std::wstring s){std::transform(s.begin(),s.end(),s.begin(),::towlower);return s;}
static bool beneath(std::wstring const& parent,std::wstring const& child){auto a=lower(parent),b=lower(child);return a==b||(b.size()>a.size()&&b.compare(0,a.size(),a)==0&&b[a.size()]==L'\\');}
static std::wstring full(std::string const& relative){
  if(relative.empty())return root;fs::path p(ws(relative));if(p.is_absolute()||p.has_root_path())winrt::throw_hresult(E_ACCESSDENIED);
  for(auto const& part:p)if(part==L".."||part==L"."||part.wstring().find(L':')!=std::wstring::npos)winrt::throw_hresult(E_ACCESSDENIED);
  auto result=(fs::path(root)/p).lexically_normal().wstring();if(!beneath(root,result))winrt::throw_hresult(E_ACCESSDENIED);return result;
}
static std::wstring cached(std::string const& value){auto p=fs::absolute(ws(value)).lexically_normal().wstring();if(!beneath(cacheRoot,p)||p==cacheRoot)winrt::throw_hresult(E_ACCESSDENIED);return p;}
struct Handle {HANDLE h=INVALID_HANDLE_VALUE;Handle()=default;explicit Handle(HANDLE value):h(value){}~Handle(){if(h!=INVALID_HANDLE_VALUE)CloseHandle(h);}Handle(Handle const&)=delete;};
// References protect short metadata/mutation operations from an oplock break.
// Never keep this reference across network hydration.
struct Protected {HANDLE h=INVALID_HANDLE_VALUE;explicit Protected(std::wstring const& p,bool deleteAccess=false){check(CfOpenFileWithOplock(p.c_str(),CF_OPEN_FILE_FLAG_EXCLUSIVE|CF_OPEN_FILE_FLAG_WRITE_ACCESS|(deleteAccess?CF_OPEN_FILE_FLAG_DELETE_ACCESS:CF_OPEN_FILE_FLAG_NONE),&h));if(!CfReferenceProtectedHandle(h)){CfCloseHandle(h);h=INVALID_HANDLE_VALUE;winrt::throw_hresult(HRESULT_FROM_WIN32(ERROR_SHARING_VIOLATION));}}~Protected(){if(h!=INVALID_HANDLE_VALUE){CfReleaseProtectedHandle(h);CfCloseHandle(h);}}};
static Handle* attributes(std::wstring const& p){auto h=CreateFileW(p.c_str(),FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT|FILE_FLAG_BACKUP_SEMANTICS,nullptr);wincheck(h!=INVALID_HANDLE_VALUE);return new Handle(h);}
static FILE_BASIC_INFO basic(HANDLE h){FILE_BASIC_INFO b{};wincheck(GetFileInformationByHandleEx(h,FileBasicInfo,&b,sizeof(b)));return b;}
static std::string fileId(HANDLE h){BY_HANDLE_FILE_INFORMATION info{};wincheck(GetFileInformationByHandle(h,&info));return std::to_string(info.dwVolumeSerialNumber)+":"+std::to_string(info.nFileIndexHigh)+":"+std::to_string(info.nFileIndexLow);}
static std::string stamp(HANDLE h){auto b=basic(h);FILE_STANDARD_INFO s{};wincheck(GetFileInformationByHandleEx(h,FileStandardInfo,&s,sizeof(s)));return std::to_string(b.LastWriteTime.QuadPart)+":"+std::to_string(b.ChangeTime.QuadPart)+":"+std::to_string(s.EndOfFile.QuadPart);}
static std::vector<BYTE> placeholderInfo(HANDLE h){std::vector<BYTE> bytes(sizeof(CF_PLACEHOLDER_STANDARD_INFO)+4096);DWORD written=0;check(CfGetPlaceholderInfo(h,CF_PLACEHOLDER_INFO_STANDARD,bytes.data(),static_cast<DWORD>(bytes.size()),&written));return bytes;}
static std::string fileIdentity(HANDLE h){auto data=placeholderInfo(h);auto* info=reinterpret_cast<CF_PLACEHOLDER_STANDARD_INFO*>(data.data());return std::string(reinterpret_cast<char*>(info->FileIdentity),info->FileIdentityLength);}
static void requireOwned(HANDLE h,std::string const& identity){if(identity.empty()||fileIdentity(h)!=identity)winrt::throw_hresult(E_ACCESSDENIED);}
static void resetCheck(){if(resetCanceled)winrt::throw_hresult(HRESULT_FROM_WIN32(ERROR_OPERATION_ABORTED));}
// Only read ranges already present on disk. Unknown gaps are never presented as a complete file.
static std::vector<std::pair<LONGLONG,LONGLONG>> localRanges(HANDLE file,CF_PLACEHOLDER_RANGE_INFO_CLASS kind,LONGLONG size){
  std::vector<std::pair<LONGLONG,LONGLONG>> ranges;LONGLONG cursor=0;
  while(cursor<size){resetCheck();CF_FILE_RANGE entries[256]{};LARGE_INTEGER offset{},length{};offset.QuadPart=cursor;length.QuadPart=CF_EOF;DWORD bytes=0;auto hr=CfGetPlaceholderRangeInfo(file,kind,offset,length,entries,sizeof(entries),&bytes);if(hr==HRESULT_FROM_WIN32(ERROR_HANDLE_EOF))break;if(FAILED(hr)&&hr!=HRESULT_FROM_WIN32(ERROR_MORE_DATA))check(hr);auto count=bytes/sizeof(CF_FILE_RANGE);if(!count){if(FAILED(hr))check(hr);break;}auto next=cursor;for(DWORD i=0;i<count;i++){auto begin=std::max(cursor,entries[i].StartingOffset.QuadPart),end=std::min(size,entries[i].StartingOffset.QuadPart+entries[i].Length.QuadPart);if(end>begin){ranges.emplace_back(begin,end);next=std::max(next,end);}}if(next<=cursor)winrt::throw_hresult(E_UNEXPECTED);cursor=next;if(SUCCEEDED(hr))break;
  }return ranges;
}
static std::string preservePartial(std::wstring const& p,std::string const& identity,std::wstring const& recovery){
  resetCheck();fs::create_directories(recovery);GUID id{};check(CoCreateGuid(&id));auto filename=utf(winrt::to_hstring(id).c_str())+".partial";auto destination=(fs::path(recovery)/ws(filename)).wstring();
  Handle source(CreateFileW(p.c_str(),GENERIC_READ|FILE_READ_ATTRIBUTES,FILE_SHARE_READ,nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT|FILE_FLAG_OPEN_NO_RECALL,nullptr));wincheck(source.h!=INVALID_HANDLE_VALUE);requireOwned(source.h,identity);auto originalStamp=stamp(source.h);FILE_STANDARD_INFO info{};wincheck(GetFileInformationByHandleEx(source.h,FileStandardInfo,&info,sizeof(info)));
  auto physical=localRanges(source.h,CF_PLACEHOLDER_RANGE_INFO_ONDISK,info.EndOfFile.QuadPart),validated=localRanges(source.h,CF_PLACEHOLDER_RANGE_INFO_VALIDATED,info.EndOfFile.QuadPart),modified=localRanges(source.h,CF_PLACEHOLDER_RANGE_INFO_MODIFIED,info.EndOfFile.QuadPart);std::vector<std::pair<LONGLONG,LONGLONG>> preserved;
  Handle output(CreateFileW(destination.c_str(),GENERIC_WRITE,0,nullptr,CREATE_NEW,FILE_ATTRIBUTE_NORMAL,nullptr));wincheck(output.h!=INVALID_HANDLE_VALUE);DWORD returned=0;wincheck(DeviceIoControl(output.h,FSCTL_SET_SPARSE,nullptr,0,nullptr,0,&returned,nullptr));wincheck(SetFilePointerEx(output.h,info.EndOfFile,nullptr,FILE_BEGIN));wincheck(SetEndOfFile(output.h));std::vector<char> buffer(1024*1024);
  auto retrieve=[&](auto&& self,LONGLONG offset,LONGLONG length)->void{resetCheck();commandStage="reset.partial.read/"+std::to_string(offset)+"/"+std::to_string(length);LARGE_INTEGER at{};at.QuadPart=offset;wincheck(SetFilePointerEx(source.h,at,nullptr,FILE_BEGIN));DWORD read=0;BOOL success=ReadFile(source.h,buffer.data(),static_cast<DWORD>(length),&read,nullptr);if(!success){auto error=GetLastError();if((error==ERROR_CLOUD_FILE_ACCESS_DENIED||error==ERROR_CLOUD_FILE_UNSUCCESSFUL)&&length>4096){auto first=(length/2/4096)*4096;if(!first)first=4096;self(self,offset,first);self(self,offset+first,length-first);return;}for(auto const& range:modified)if(offset<range.second&&offset+length>range.first)winrt::throw_hresult(HRESULT_FROM_WIN32(error));if(error==ERROR_CLOUD_FILE_ACCESS_DENIED||error==ERROR_CLOUD_FILE_UNSUCCESSFUL)return;winrt::throw_hresult(HRESULT_FROM_WIN32(error));}if(read!=length)winrt::throw_hresult(HRESULT_FROM_WIN32(ERROR_READ_FAULT));wincheck(SetFilePointerEx(output.h,at,nullptr,FILE_BEGIN));DWORD written=0;wincheck(WriteFile(output.h,buffer.data(),read,&written,nullptr));if(written!=read)winrt::throw_hresult(HRESULT_FROM_WIN32(ERROR_WRITE_FAULT));if(!preserved.empty()&&preserved.back().second==offset)preserved.back().second=offset+length;else preserved.emplace_back(offset,offset+length);
  };
  for(auto const& range:physical)for(auto offset=range.first;offset<range.second;){auto length=std::min<LONGLONG>(buffer.size(),range.second-offset);retrieve(retrieve,offset,length);offset+=length;}
  if(preserved.empty()&&!physical.empty())winrt::throw_hresult(HRESULT_FROM_WIN32(ERROR_CLOUD_FILE_INVALID_REQUEST));
  for(auto const* required:{&validated,&modified})for(auto const& range:*required){auto cursor=range.first;for(auto const& copy:preserved){if(copy.first>cursor)break;if(copy.second>cursor)cursor=copy.second;if(cursor>=range.second)break;}if(cursor<range.second)winrt::throw_hresult(HRESULT_FROM_WIN32(ERROR_CLOUD_FILE_ACCESS_DENIED));}
  wincheck(FlushFileBuffers(output.h));JsonObject metadata;put(metadata,L"format","amg-partial-v1");putb(metadata,L"complete",false);put(metadata,L"path",utf(fs::relative(p,root).wstring()));put(metadata,L"identity",identity);put(metadata,L"stamp",originalStamp);putn(metadata,L"size",static_cast<double>(info.EndOfFile.QuadPart));put(metadata,L"file",filename);JsonArray ranges;for(auto const& range:preserved){JsonObject item;putn(item,L"offset",static_cast<double>(range.first));putn(item,L"length",static_cast<double>(range.second-range.first));ranges.Append(item);}metadata.Insert(L"ranges",ranges);auto json=utf(metadata.Stringify().c_str());Handle manifest(CreateFileW((destination+L".json").c_str(),GENERIC_WRITE,0,nullptr,CREATE_NEW,FILE_ATTRIBUTE_NORMAL,nullptr));wincheck(manifest.h!=INVALID_HANDLE_VALUE);DWORD written=0;wincheck(WriteFile(manifest.h,json.data(),static_cast<DWORD>(json.size()),&written,nullptr));if(written!=json.size())winrt::throw_hresult(HRESULT_FROM_WIN32(ERROR_WRITE_FAULT));wincheck(FlushFileBuffers(manifest.h));return originalStamp;
}
static bool ownsRoot(std::wstring const& p){std::vector<BYTE> bytes(sizeof(CF_SYNC_ROOT_STANDARD_INFO)+4096);DWORD written=0;auto hr=CfGetSyncRootInfoByPath(p.c_str(),CF_SYNC_ROOT_INFO_STANDARD,bytes.data(),static_cast<DWORD>(bytes.size()),&written);if(FAILED(hr))return false;auto* info=reinterpret_cast<CF_SYNC_ROOT_STANDARD_INFO*>(bytes.data());return std::string(reinterpret_cast<char*>(info->SyncRootIdentity),info->SyncRootIdentityLength)==owner;}
static bool registeredRoot(std::wstring const& p){std::vector<BYTE> bytes(sizeof(CF_SYNC_ROOT_STANDARD_INFO)+4096);DWORD written=0;return SUCCEEDED(CfGetSyncRootInfoByPath(p.c_str(),CF_SYNC_ROOT_INFO_STANDARD,bytes.data(),static_cast<DWORD>(bytes.size()),&written));}
static std::wstring shellId(){
  Handle token;wincheck(OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&token.h));DWORD size=0;GetTokenInformation(token.h,TokenUser,nullptr,0,&size);std::vector<BYTE> bytes(size);wincheck(GetTokenInformation(token.h,TokenUser,bytes.data(),size,&size));LPWSTR sid=nullptr;wincheck(ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(bytes.data())->User.Sid,&sid));std::wstring result=L"AMG.Dropbox!"+std::wstring(sid)+L"!"+ws(owner.substr(std::string("AMG.CloudFiles/").size()));LocalFree(sid);return result;
}
static std::string shellContext(winrt::Windows::Storage::Provider::StorageProviderSyncRootInfo const& info){return winrt::to_string(winrt::Windows::Security::Cryptography::CryptographicBuffer::ConvertBinaryToString(winrt::Windows::Security::Cryptography::BinaryStringEncoding::Utf8,info.Context()));}
static void checkShellBindings(){
  using winrt::Windows::Storage::Provider::StorageProviderSyncRootManager;
  const auto expected=shellId(),prefix=expected.substr(0,expected.rfind(L'!')+1);std::vector<std::wstring> stale;
  for(auto const& info:StorageProviderSyncRootManager::GetCurrentSyncRoots()){
    auto id=std::wstring(info.Id()),p=fs::path(std::wstring(info.Path().Path())).lexically_normal().wstring();
    if(id==expected){if(lower(p)!=lower(root)||(!shellContext(info).empty()&&shellContext(info)!=owner))winrt::throw_hresult(E_ACCESSDENIED);continue;}
    if(!beneath(p,root)&&!beneath(root,p))continue;
    const auto suffix=id.substr(id.rfind(L'!')+1);
    if(lower(p)!=lower(root)||id.rfind(prefix,0)!=0||(!shellContext(info).empty()&&shellContext(info)!="AMG.CloudFiles/"+utf(suffix))||registeredRoot(root)||!fs::is_empty(root))winrt::throw_hresult(E_ACCESSDENIED);
    stale.push_back(id);
  }
  for(auto const& id:stale){if(registeredRoot(root)||!fs::is_empty(root))winrt::throw_hresult(E_ACCESSDENIED);StorageProviderSyncRootManager::Unregister(id);}
}
static void notifyShell(std::wstring const& filename){SHChangeNotify(SHCNE_UPDATEITEM,SHCNF_PATHW|SHCNF_FLUSHNOWAIT,filename.c_str(),nullptr);}
static HRESULT transferState(std::wstring const& filename,bool busy,ULONGLONG completed=0,ULONGLONG total=0){
  try{winrt::com_ptr<IShellItem2> item;check(SHCreateItemFromParsingName(filename.c_str(),nullptr,IID_PPV_ARGS(item.put())));winrt::com_ptr<IPropertyStore> properties;check(item->GetPropertyStore(static_cast<GETPROPERTYSTOREFLAGS>(GPS_READWRITE|GPS_VOLATILEPROPERTIESONLY),IID_PPV_ARGS(properties.put())));
    PROPVARIANT status;PropVariantInit(&status);check(InitPropVariantFromUInt32(busy?STS_TRANSFERRING:STS_NONE,&status));auto hr=properties->SetValue(PKEY_SyncTransferStatus,status);PropVariantClear(&status);check(hr);
    static const PROPERTYKEY progress={{0xe77e90df,0x6271,0x4f5b,{0x83,0x4f,0x2d,0xd1,0xf2,0x45,0xdd,0xa4}},4};ULONGLONG values[]={completed,total};PROPVARIANT value;PropVariantInit(&value);check(InitPropVariantFromUInt64Vector(values,2,&value));hr=properties->SetValue(progress,value);PropVariantClear(&value);check(hr);check(properties->Commit());notifyShell(filename);return S_OK;
  }catch(winrt::hresult_error const& e){return e.code();} // Presentation must never interrupt data transfer.
}
static winrt::com_ptr<ISearchCrawlScopeManager> searchScope(){winrt::com_ptr<ISearchManager> manager;check(CoCreateInstance(__uuidof(CSearchManager),nullptr,CLSCTX_SERVER,IID_PPV_ARGS(manager.put())));winrt::com_ptr<ISearchCatalogManager> catalog;check(manager->GetCatalog(L"SystemIndex",catalog.put()));winrt::com_ptr<ISearchCrawlScopeManager> scope;check(catalog->GetCrawlScopeManager(scope.put()));return scope;}
static std::wstring indexUrl(std::wstring const& p){return L"file:///"+p;}
static bool indexed(std::wstring const& p){BOOL included=FALSE;check(searchScope()->IncludedInCrawlScope(indexUrl(p).c_str(),&included));return included!=FALSE;}
static bool registerIndex(){
  if(indexed(root))return true;
  // Explorer caches cloud availability/progress in Windows Search, even for roots outside the user profile.
  // Add only our root; explicit user exclusions retain precedence over this default rule.
  auto marker=fs::path(cacheRoot)/L"index-scope.txt";std::ofstream intent(marker,std::ios::binary);intent<<utf(root);intent.close();if(!intent)winrt::throw_hresult(E_FAIL);
  auto scope=searchScope();check(scope->AddDefaultScopeRule(indexUrl(root).c_str(),TRUE,FF_INDEXCOMPLEXURLS));check(scope->SaveAll());return indexed(root);
}
static void unregisterIndex(){auto marker=fs::path(cacheRoot)/L"index-scope.txt";std::ifstream input(marker,std::ios::binary);std::string saved((std::istreambuf_iterator<char>(input)),{});input.close();if(saved!=utf(root))return;auto scope=searchScope();check(scope->RemoveDefaultScopeRule(indexUrl(root).c_str()));check(scope->SaveAll());fs::remove(marker);}
static void registerShell(std::string const& display){
  using namespace winrt::Windows::Storage;using namespace winrt::Windows::Storage::Provider;
  StorageProviderSyncRootInfo info;info.Id(shellId());info.Path(StorageFolder::GetFolderFromPathAsync(root).get());info.DisplayNameResource(winrt::to_hstring("AMG Dropbox · "+display));
  info.IconResource(L"%SystemRoot%\\system32\\imageres.dll,-1040");info.ProviderId(providerId);info.Version(AMG_VERSION);info.AllowPinning(true);info.ShowSiblingsAsGroup(false);
  info.HydrationPolicy(StorageProviderHydrationPolicy::Partial);info.PopulationPolicy(StorageProviderPopulationPolicy::AlwaysFull);info.HardlinkPolicy(StorageProviderHardlinkPolicy::None);
  info.InSyncPolicy(StorageProviderInSyncPolicy::FileLastWriteTime|StorageProviderInSyncPolicy::FileHiddenAttribute|StorageProviderInSyncPolicy::FileReadOnlyAttribute);
  info.Context(winrt::Windows::Security::Cryptography::CryptographicBuffer::ConvertStringToBinary(winrt::to_hstring(owner),winrt::Windows::Security::Cryptography::BinaryStringEncoding::Utf8));
  StorageProviderSyncRootManager::Register(info);SHChangeNotify(SHCNE_ASSOCCHANGED,SHCNF_IDLIST|SHCNF_FLUSHNOWAIT,nullptr,nullptr);notifyShell(root);
}
static void unregisterRoot(){
  commandStage="unregister.verify";
  bool shellOwned=false;for(auto const& info:winrt::Windows::Storage::Provider::StorageProviderSyncRootManager::GetCurrentSyncRoots())if(std::wstring(info.Id())==shellId()){if(lower(std::wstring(info.Path().Path()))!=lower(root)||(!shellContext(info).empty()&&shellContext(info)!=owner))winrt::throw_hresult(E_ACCESSDENIED);shellOwned=true;}
  if(ownsRoot(root)||shellOwned){commandStage="unregister.index";try{unregisterIndex();}catch(winrt::hresult_error const&){ }}
  commandStage="unregister.shell";if(connected){check(CfDisconnectSyncRoot(connection));connected=false;}
  if(shellOwned)winrt::Windows::Storage::Provider::StorageProviderSyncRootManager::Unregister(shellId());
  if(ownsRoot(root))check(CfUnregisterSyncRoot(root.c_str()));notifyShell(root);
}
static CF_FS_METADATA metadata(JsonObject const& command){CF_FS_METADATA m{};auto time=static_cast<LONGLONG>(num(command,L"modified",0)*10000)+116444736000000000LL;if(time<116444736000000000LL)time=116444736000000000LL;m.BasicInfo.CreationTime.QuadPart=time;m.BasicInfo.LastAccessTime.QuadPart=time;m.BasicInfo.LastWriteTime.QuadPart=time;m.BasicInfo.ChangeTime.QuadPart=time;m.BasicInfo.FileAttributes=jsonBool(command,L"directory")?FILE_ATTRIBUTE_DIRECTORY:FILE_ATTRIBUTE_NORMAL;m.FileSize.QuadPart=static_cast<LONGLONG>(num(command,L"size"));return m;}

struct Request {CF_OPERATION_INFO info{};std::string identity;std::wstring path;LONGLONG offset=0,length=0,size=0;CF_OPERATION_TYPE kind=CF_OPERATION_TYPE_TRANSFER_DATA;};
static std::map<std::string,Request> requests;
static CF_OPERATION_INFO operation(CF_CALLBACK_INFO const* info,CF_OPERATION_TYPE kind){CF_OPERATION_INFO result{};result.StructSize=sizeof(result);result.Type=kind;result.ConnectionKey=info->ConnectionKey;result.TransferKey=info->TransferKey;result.RequestKey=info->RequestKey;return result;}
static void ack(CF_OPERATION_INFO const& info,NTSTATUS status){CF_OPERATION_PARAMETERS p{};p.ParamSize=info.Type==CF_OPERATION_TYPE_ACK_DELETE?CF_SIZE_OF_OP_PARAM(AckDelete):CF_SIZE_OF_OP_PARAM(AckRename);if(info.Type==CF_OPERATION_TYPE_ACK_DELETE)p.AckDelete.CompletionStatus=status;else p.AckRename.CompletionStatus=status;check(CfExecute(&info,&p));}
static std::string relativeCallback(CF_CALLBACK_INFO const* info,PCWSTR incoming){std::wstring value=incoming?incoming:L"";if(value.size()&&value[0]==L'\\'&&!(value.size()>1&&value[1]==L'\\'))value=std::wstring(info->VolumeDosName)+value;if(!beneath(root,value))winrt::throw_hresult(E_ACCESSDENIED);if(value==root)return "";return utf(value.substr(root.size()+1));}
static bool recycleTarget(CF_CALLBACK_INFO const* info,PCWSTR incoming){std::wstring target=incoming?incoming:L"";if(target.size()&&target[0]==L'\\'&&!(target.size()>1&&target[1]==L'\\'))target=std::wstring(info->VolumeDosName)+target;target=fs::path(target).lexically_normal().wstring();auto id=shellId();auto first=id.find(L'!'),last=id.rfind(L'!');auto recycle=std::wstring(info->VolumeDosName)+L"\\$Recycle.Bin\\"+id.substr(first+1,last-first-1);return lower(fs::path(target).parent_path().wstring())==lower(recycle)&&fs::path(target).filename().wstring().starts_with(L"$R");}
static void CALLBACK onFetch(CF_CALLBACK_INFO const* info,CF_CALLBACK_PARAMETERS const* params){
  try{if(resetNoFetch)winrt::throw_hresult(E_ACCESSDENIED);winrt::init_apartment(winrt::apartment_type::multi_threaded);Request r;r.info=operation(info,CF_OPERATION_TYPE_TRANSFER_DATA);r.identity=std::string(static_cast<char const*>(info->FileIdentity),info->FileIdentityLength);r.offset=params->FetchData.RequiredFileOffset.QuadPart;r.length=params->FetchData.RequiredLength.QuadPart;r.size=info->FileSize.QuadPart;
    r.path=full(relativeCallback(info,info->NormalizedPath));auto id=std::to_string(++sequence);{std::lock_guard<std::mutex> lock(requestsMutex);requests.emplace(id,r);}transferState(r.path,true,0,r.size);JsonObject event;put(event,L"event","fetch");put(event,L"request",id);put(event,L"identity",r.identity);putn(event,L"offset",static_cast<double>(r.offset));putn(event,L"length",static_cast<double>(r.length));putn(event,L"size",static_cast<double>(r.size));emit(event);
  }catch(...){auto op=operation(info,CF_OPERATION_TYPE_TRANSFER_DATA);CF_OPERATION_PARAMETERS p{};p.ParamSize=CF_SIZE_OF_OP_PARAM(TransferData);p.TransferData.CompletionStatus=failedStatus;p.TransferData.Offset=params->FetchData.RequiredFileOffset;p.TransferData.Length=params->FetchData.RequiredLength;CfExecute(&op,&p);}
}
static void CALLBACK onCancel(CF_CALLBACK_INFO const* info,CF_CALLBACK_PARAMETERS const*){
  try{winrt::init_apartment(winrt::apartment_type::multi_threaded);std::vector<std::wstring> paths;{std::lock_guard<std::mutex> lock(requestsMutex);for(auto it=requests.begin();it!=requests.end();){if(it->second.info.TransferKey.QuadPart==info->TransferKey.QuadPart){JsonObject event;put(event,L"event","cancel");put(event,L"request",it->first);emit(event);paths.push_back(it->second.path);it=requests.erase(it);}else ++it;}paths.erase(std::remove_if(paths.begin(),paths.end(),[](auto const& p){return std::any_of(requests.begin(),requests.end(),[&](auto const& entry){return entry.second.path==p;});}),paths.end());}for(auto const& p:paths)if(!p.empty())transferState(p,false);}catch(...){}
}
static void notify(CF_CALLBACK_INFO const* info,CF_CALLBACK_PARAMETERS const* params,bool rename){
  auto op=operation(info,rename?CF_OPERATION_TYPE_ACK_RENAME:CF_OPERATION_TYPE_ACK_DELETE);
  try{if(info->ProcessInfo&&info->ProcessInfo->ProcessId==GetCurrentProcessId()){ack(op,0);return;}
    winrt::init_apartment(winrt::apartment_type::multi_threaded);Request r;r.info=op;r.kind=op.Type;if(info->FileIdentity&&info->FileIdentityLength)r.identity=std::string(static_cast<char const*>(info->FileIdentity),info->FileIdentityLength);
    JsonObject event;put(event,L"event",rename?"rename":"delete");auto id=std::to_string(++sequence);put(event,L"request",id);put(event,L"identity",r.identity);put(event,L"path",relativeCallback(info,info->NormalizedPath));putn(event,L"flags",rename?params->Rename.Flags:params->Delete.Flags);if(rename){if(params->Rename.Flags&CF_CALLBACK_RENAME_FLAG_TARGET_IN_SCOPE)put(event,L"target",relativeCallback(info,params->Rename.TargetPath));else if(recycleTarget(info,params->Rename.TargetPath))put(event,L"event","recycle");else winrt::throw_hresult(E_ACCESSDENIED);}{std::lock_guard<std::mutex> lock(requestsMutex);requests.emplace(id,r);}emit(event);
  }catch(...){JsonObject event;put(event,L"event","nativeError");put(event,L"operation",rename?"rename":"delete");if(rename)put(event,L"target",utf(params->Rename.TargetPath));emit(event);try{ack(op,deniedStatus);}catch(...) {}}
}
static void CALLBACK onDelete(CF_CALLBACK_INFO const* info,CF_CALLBACK_PARAMETERS const* p){notify(info,p,false);}
static void CALLBACK onRename(CF_CALLBACK_INFO const* info,CF_CALLBACK_PARAMETERS const* p){notify(info,p,true);}
static void CALLBACK onDeleteCompleted(CF_CALLBACK_INFO const* info,CF_CALLBACK_PARAMETERS const*){try{winrt::init_apartment(winrt::apartment_type::multi_threaded);JsonObject e;put(e,L"event","completed");put(e,L"path",relativeCallback(info,info->NormalizedPath));emit(e);}catch(...) {}}
static void CALLBACK onRenameCompleted(CF_CALLBACK_INFO const* info,CF_CALLBACK_PARAMETERS const* p){try{winrt::init_apartment(winrt::apartment_type::multi_threaded);JsonObject e;put(e,L"event","completed");put(e,L"path",relativeCallback(info,p->RenameCompletion.SourcePath));emit(e);}catch(...) {}}
static void CALLBACK onClose(CF_CALLBACK_INFO const* info,CF_CALLBACK_PARAMETERS const* p){try{winrt::init_apartment(winrt::apartment_type::multi_threaded);JsonObject e;put(e,L"event",p->CloseCompletion.Flags&CF_CALLBACK_CLOSE_COMPLETION_FLAG_DELETED?"completed":"changed");put(e,L"path",relativeCallback(info,info->NormalizedPath));emit(e);}catch(...) {}}
static CF_CALLBACK_REGISTRATION callbacks[]={{CF_CALLBACK_TYPE_FETCH_DATA,onFetch},{CF_CALLBACK_TYPE_CANCEL_FETCH_DATA,onCancel},{CF_CALLBACK_TYPE_NOTIFY_DELETE,onDelete},{CF_CALLBACK_TYPE_NOTIFY_DELETE_COMPLETION,onDeleteCompleted},{CF_CALLBACK_TYPE_NOTIFY_RENAME,onRename},{CF_CALLBACK_TYPE_NOTIFY_RENAME_COMPLETION,onRenameCompleted},{CF_CALLBACK_TYPE_NOTIFY_FILE_CLOSE_COMPLETION,onClose},CF_CALLBACK_REGISTRATION_END};

static JsonObject inspectPath(JsonObject const& command){
  auto p=full(str(command,L"path"));JsonObject result;auto attr=GetFileAttributesW(p.c_str());if(attr==INVALID_FILE_ATTRIBUTES){putb(result,L"exists",false);return result;}putb(result,L"exists",true);putb(result,L"directory",(attr&FILE_ATTRIBUTE_DIRECTORY)!=0);
  std::unique_ptr<Handle> handle(attributes(p));FILE_ATTRIBUTE_TAG_INFO tag{};wincheck(GetFileInformationByHandleEx(handle->h,FileAttributeTagInfo,&tag,sizeof(tag)));auto state=CfGetPlaceholderStateFromAttributeTag(tag.FileAttributes,tag.ReparseTag);bool isPlaceholder=(state&CF_PLACEHOLDER_STATE_PLACEHOLDER)!=0;putb(result,L"placeholder",isPlaceholder);put(result,L"stamp",stamp(handle->h));auto b=basic(handle->h);putn(result,L"modified",(b.LastWriteTime.QuadPart-116444736000000000LL)/10000.0);
  FILE_STANDARD_INFO standard{};wincheck(GetFileInformationByHandleEx(handle->h,FileStandardInfo,&standard,sizeof(standard)));putn(result,L"size",static_cast<double>(standard.EndOfFile.QuadPart));
  if(isPlaceholder){auto bytes=placeholderInfo(handle->h);auto* i=reinterpret_cast<CF_PLACEHOLDER_STANDARD_INFO*>(bytes.data());put(result,L"identity",std::string(reinterpret_cast<char*>(i->FileIdentity),i->FileIdentityLength));putb(result,L"inSync",i->InSyncState==CF_IN_SYNC_STATE_IN_SYNC);putn(result,L"pin",i->PinState);putn(result,L"onDisk",static_cast<double>(i->OnDiskDataSize.QuadPart));putn(result,L"dirtyBytes",static_cast<double>(i->ModifiedDataSize.QuadPart));putb(result,L"partial",(state&CF_PLACEHOLDER_STATE_PARTIAL)!=0);}
  return result;
}
static JsonObject handleCommand(JsonObject const& cmd){
  std::string action=str(cmd,L"command");JsonObject result;
  if(action=="probe"){CF_PLATFORM_INFO info{};auto hr=CfGetPlatformInfo(&info);putb(result,L"supported",SUCCEEDED(hr));putn(result,L"build",info.BuildNumber);putn(result,L"revision",info.RevisionNumber);return result;}
  if(action=="checkPath"){std::vector<BYTE> bytes(sizeof(CF_SYNC_ROOT_STANDARD_INFO)+4096);DWORD written=0;auto hr=CfGetSyncRootInfoByPath(ws(str(cmd,L"path")).c_str(),CF_SYNC_ROOT_INFO_STANDARD,bytes.data(),static_cast<DWORD>(bytes.size()),&written);putb(result,L"registered",SUCCEEDED(hr));return result;}
  if(action=="indexState"){putb(result,L"indexed",indexed(ws(str(cmd,L"path"))));return result;}
  if(action=="shellState"){
    auto p=ws(str(cmd,L"path"));winrt::com_ptr<IPropertyStore> properties;check(SHGetPropertyStoreFromParsingName(p.c_str(),nullptr,GPS_DEFAULT,IID_PPV_ARGS(properties.put())));
    auto read=[&](PROPERTYKEY const& key,wchar_t const* name){PROPVARIANT v;PropVariantInit(&v);if(SUCCEEDED(properties->GetValue(key,&v))){PWSTR text=nullptr;if(SUCCEEDED(PropVariantToStringAlloc(v,&text))){put(result,name,utf(text));CoTaskMemFree(text);}}PropVariantClear(&v);};
    read(PKEY_StorageProviderId,L"providerId");read(PKEY_StorageProviderState,L"providerState");read(PKEY_FilePlaceholderStatus,L"placeholderStatus");read(PKEY_FileOfflineAvailabilityStatus,L"availability");read(PKEY_SyncTransferStatus,L"transfer");
    PROPERTYKEY uiStatus{};if(SUCCEEDED(PSGetPropertyKeyFromName(L"System.StorageProviderUIStatus",&uiStatus)))read(uiStatus,L"uiStatus");
    winrt::com_ptr<IShellItem2> item;if(SUCCEEDED(SHCreateItemFromParsingName(p.c_str(),nullptr,IID_PPV_ARGS(item.put())))){winrt::com_ptr<IPropertyStore> transient;if(SUCCEEDED(item->GetPropertyStore(GPS_VOLATILEPROPERTIESONLY,IID_PPV_ARGS(transient.put())))){properties=transient;read(PKEY_SyncTransferStatus,L"transfer");}}
    return result;
  }
  if(action=="drives"){JsonArray array;DWORD mask=GetLogicalDrives();for(wchar_t letter=L'A';letter<=L'Z';letter++){std::wstring device{letter,L':'};wchar_t target[32768]{};bool queried=QueryDosDeviceW(device.c_str(),target,32768)!=0;bool occupied=(mask&(1<<(letter-L'A')))||queried;JsonObject d;put(d,L"letter",utf(std::wstring(1,letter)));putb(d,L"available",!occupied);put(d,L"target",occupied?utf(target):"");array.Append(d);}result.Insert(L"drives",array);return result;}
  if(action=="releaseEmpty"){if(!root.empty()&&ownsRoot(root)){if(!fs::is_empty(root))winrt::throw_hresult(E_ACCESSDENIED);unregisterRoot();}return result;}
  if(action=="releaseInactiveEmpty"){
    std::lock_guard<std::mutex> lock(mutationMutex);if(connected)winrt::throw_hresult(E_UNEXPECTED);root=fs::absolute(ws(str(cmd,L"root"))).lexically_normal().wstring();cacheRoot=fs::absolute(ws(str(cmd,L"cache"))).lexically_normal().wstring();owner="AMG.CloudFiles/"+str(cmd,L"owner");if(owner.size()<32)winrt::throw_hresult(E_INVALIDARG);
    commandStage="releaseInactiveEmpty.verify";if(!fs::is_directory(root)||!fs::is_empty(root)||(registeredRoot(root)&&!ownsRoot(root)))winrt::throw_hresult(E_ACCESSDENIED);
    for(auto const& info:winrt::Windows::Storage::Provider::StorageProviderSyncRootManager::GetCurrentSyncRoots())if(std::wstring(info.Id())==shellId()){if(lower(std::wstring(info.Path().Path()))!=lower(root)||(!shellContext(info).empty()&&shellContext(info)!=owner))winrt::throw_hresult(E_ACCESSDENIED);}
    commandStage="releaseInactiveEmpty.unregister";unregisterRoot();putb(result,L"released",true);return result;
  }
  if(action=="init"){
    std::lock_guard<std::mutex> lock(mutationMutex);if(connected)winrt::throw_hresult(E_UNEXPECTED);root=fs::absolute(ws(str(cmd,L"root"))).lexically_normal().wstring();cacheRoot=fs::absolute(ws(str(cmd,L"cache"))).lexically_normal().wstring();owner="AMG.CloudFiles/"+str(cmd,L"owner");if(owner.size()<32)winrt::throw_hresult(E_INVALIDARG);
    wchar_t volume[MAX_PATH]{},filesystem[MAX_PATH]{};wincheck(GetVolumePathNameW(root.c_str(),volume,MAX_PATH));wincheck(GetVolumeInformationW(volume,nullptr,0,nullptr,nullptr,nullptr,filesystem,MAX_PATH));if(_wcsicmp(filesystem,L"NTFS"))winrt::throw_hresult(HRESULT_FROM_WIN32(ERROR_NOT_SUPPORTED));
    commandStage="init.ownership";bool already=ownsRoot(root);if(registeredRoot(root)&&!already)winrt::throw_hresult(E_ACCESSDENIED);auto attr=GetFileAttributesW(root.c_str());if(attr==INVALID_FILE_ATTRIBUTES||!(attr&FILE_ATTRIBUTE_DIRECTORY)||((attr&FILE_ATTRIBUTE_REPARSE_POINT)&&!already))winrt::throw_hresult(E_ACCESSDENIED);
    if(!already&&!fs::is_empty(root))winrt::throw_hresult(HRESULT_FROM_WIN32(ERROR_DIR_NOT_EMPTY));
    CF_SYNC_REGISTRATION registration{};registration.StructSize=sizeof(registration);registration.ProviderName=L"AMG Dropbox";registration.ProviderVersion=AMG_VERSION;registration.SyncRootIdentity=owner.data();registration.SyncRootIdentityLength=static_cast<DWORD>(owner.size());registration.ProviderId=providerId;
    CF_SYNC_POLICIES policies{};policies.StructSize=sizeof(policies);policies.Hydration.Primary=CF_HYDRATION_POLICY_PARTIAL;policies.Population.Primary=CF_POPULATION_POLICY_ALWAYS_FULL;policies.InSync=CF_INSYNC_POLICY_TRACK_FILE_LAST_WRITE_TIME|CF_INSYNC_POLICY_TRACK_FILE_HIDDEN_ATTRIBUTE|CF_INSYNC_POLICY_TRACK_FILE_READONLY_ATTRIBUTE;policies.HardLink=CF_HARDLINK_POLICY_NONE;
    commandStage="init.shellOwnership";checkShellBindings();
    commandStage="init.shell";try{registerShell(str(cmd,L"displayName","Dropbox"));putb(result,L"shellRegistered",true);}catch(winrt::hresult_error const& e){putb(result,L"shellRegistered",false);putn(result,L"shellError",static_cast<unsigned long>(e.code().value));}
    commandStage="init.register";if(registeredRoot(root)&&!ownsRoot(root))winrt::throw_hresult(E_ACCESSDENIED);check(CfRegisterSyncRoot(root.c_str(),&registration,&policies,ownsRoot(root)?CF_REGISTER_FLAG_UPDATE:CF_REGISTER_FLAG_NONE));if(!ownsRoot(root))winrt::throw_hresult(HRESULT_FROM_WIN32(ERROR_CLOUD_FILE_NOT_UNDER_SYNC_ROOT));
    commandStage="init.connect";check(CfConnectSyncRoot(root.c_str(),callbacks,nullptr,CF_CONNECT_FLAG_REQUIRE_PROCESS_INFO|CF_CONNECT_FLAG_REQUIRE_FULL_FILE_PATH|CF_CONNECT_FLAG_BLOCK_SELF_IMPLICIT_HYDRATION,&connection));connected=true;check(CfUpdateSyncProviderStatus(connection,CF_PROVIDER_STATUS_IDLE));
    try{putb(result,L"indexed",registerIndex());}catch(winrt::hresult_error const& e){putb(result,L"indexed",false);putn(result,L"indexError",static_cast<unsigned long>(e.code().value));}
    put(result,L"root",utf(root));return result;
  }
  if(!connected||!ownsRoot(root))winrt::throw_hresult(E_ACCESSDENIED);
  if(action=="freezeForReset"){resetNoFetch=true;resetCanceled=false;check(CfDisconnectSyncRoot(connection));connected=false;check(CfConnectSyncRoot(root.c_str(),callbacks,nullptr,CF_CONNECT_FLAG_REQUIRE_PROCESS_INFO|CF_CONNECT_FLAG_REQUIRE_FULL_FILE_PATH,&connection));connected=true;return result;}
  if(action=="cancelReset"){resetCanceled=true;return result;}
  if(action=="inspect")return inspectPath(cmd);
  if(action=="providerStatus"){check(CfUpdateSyncProviderStatus(connection,jsonBool(cmd,L"busy")?CF_PROVIDER_STATUS_SYNC_INCREMENTAL:CF_PROVIDER_STATUS_IDLE));notifyShell(root);return result;}
  if(action=="transfer"){auto p=full(str(cmd,L"path"));auto identity=str(cmd,L"identity");if(!identity.empty()){std::unique_ptr<Handle> h(attributes(p));requireOwned(h->h,identity);}putn(result,L"shellResult",static_cast<unsigned long>(transferState(p,jsonBool(cmd,L"busy"),static_cast<ULONGLONG>(num(cmd,L"completed")),static_cast<ULONGLONG>(num(cmd,L"total",jsonBool(cmd,L"busy")?1:0)))));return result;}
  if(action=="detachKeepDownloaded"){
    std::lock_guard<std::mutex> lock(mutationMutex);if(!resetNoFetch)winrt::throw_hresult(E_ACCESSDENIED);resetCheck();std::map<std::wstring,std::string> known;for(auto const& value:cmd.GetNamedArray(L"items")){auto item=value.GetObject();known[lower(full(str(item,L"path")))]=str(item,L"identity");}
    struct Entry {std::wstring path;std::string identity,stamp,id;bool directory=false,discard=false,partial=false,backedUp=false;};std::vector<Entry> entries;
    commandStage="reset.preflight";
    for(auto const& entry:fs::recursive_directory_iterator(root)){
      resetCheck();auto p=entry.path().wstring();std::unique_ptr<Handle> h(attributes(p));FILE_ATTRIBUTE_TAG_INFO tag{};wincheck(GetFileInformationByHandleEx(h->h,FileAttributeTagInfo,&tag,sizeof(tag)));auto state=CfGetPlaceholderStateFromAttributeTag(tag.FileAttributes,tag.ReparseTag);
      if(state&CF_PLACEHOLDER_STATE_PLACEHOLDER){auto found=known.find(lower(p));if(found==known.end())winrt::throw_hresult(E_ACCESSDENIED);requireOwned(h->h,found->second);auto bytes=placeholderInfo(h->h);auto* info=reinterpret_cast<CF_PLACEHOLDER_STANDARD_INFO*>(bytes.data());FILE_STANDARD_INFO standard{};wincheck(GetFileInformationByHandleEx(h->h,FileStandardInfo,&standard,sizeof(standard)));bool directory=(tag.FileAttributes&FILE_ATTRIBUTE_DIRECTORY)!=0,partial=!directory&&standard.EndOfFile.QuadPart>0&&((state&CF_PLACEHOLDER_STATE_PARTIAL)||info->OnDiskDataSize.QuadPart<standard.EndOfFile.QuadPart);bool discard=partial&&!info->OnDiskDataSize.QuadPart&&!info->ModifiedDataSize.QuadPart&&info->InSyncState==CF_IN_SYNC_STATE_IN_SYNC;entries.push_back({p,found->second,stamp(h->h),fileId(h->h),directory,discard,partial});}
      else if(tag.FileAttributes&FILE_ATTRIBUTE_REPARSE_POINT)winrt::throw_hresult(E_ACCESSDENIED);
    }
    // All unknown placeholders are rejected before any local mutation. Back up every partial file first.
    commandStage="reset.preservePartial";auto recovery=cached(str(cmd,L"recovery"));for(auto& entry:entries)if(entry.partial&&!entry.discard){entry.stamp=preservePartial(entry.path,entry.identity,recovery);entry.discard=true;entry.backedUp=true;}
    std::sort(entries.begin(),entries.end(),[](auto const& a,auto const& b){return a.path.size()>b.path.size();});unsigned kept=0,removed=0;commandStage="reset.localOnly";
    for(auto const& entry:entries)for(unsigned attempt=0;;attempt++){resetCheck();try{
      auto attributesNow=GetFileAttributesW(entry.path.c_str());if(attributesNow==INVALID_FILE_ATTRIBUTES){auto error=GetLastError();if(entry.discard&&(error==ERROR_FILE_NOT_FOUND||error==ERROR_PATH_NOT_FOUND)){removed++;break;}winrt::throw_hresult(HRESULT_FROM_WIN32(error));}
      {std::unique_ptr<Handle> inspect(attributes(entry.path));FILE_ATTRIBUTE_TAG_INFO tag{};wincheck(GetFileInformationByHandleEx(inspect->h,FileAttributeTagInfo,&tag,sizeof(tag)));if(!(CfGetPlaceholderStateFromAttributeTag(tag.FileAttributes,tag.ReparseTag)&CF_PLACEHOLDER_STATE_PLACEHOLDER)){if(!entry.discard&&!(tag.FileAttributes&FILE_ATTRIBUTE_REPARSE_POINT)&&fileId(inspect->h)==entry.id){kept++;break;}winrt::throw_hresult(E_ACCESSDENIED);}}
      bool emptyDirectory=entry.directory&&fs::is_empty(entry.path);Protected h(entry.path,entry.discard||emptyDirectory);auto raw=CfGetWin32HandleFromProtectedHandle(h.h);requireOwned(raw,entry.identity);if(!entry.directory&&stamp(raw)!=entry.stamp)winrt::throw_hresult(HRESULT_FROM_WIN32(ERROR_CLOUD_FILE_NOT_IN_SYNC));
      if(emptyDirectory){FILE_DISPOSITION_INFO disposition{TRUE};wincheck(SetFileInformationByHandle(raw,FileDispositionInfo,&disposition,sizeof(disposition)));removed++;}
      else if(entry.discard){auto bytes=placeholderInfo(raw);auto* info=reinterpret_cast<CF_PLACEHOLDER_STANDARD_INFO*>(bytes.data());if(!entry.backedUp&&(info->OnDiskDataSize.QuadPart||info->ModifiedDataSize.QuadPart||info->InSyncState!=CF_IN_SYNC_STATE_IN_SYNC))winrt::throw_hresult(E_ACCESSDENIED);FILE_DISPOSITION_INFO disposition{TRUE};wincheck(SetFileInformationByHandle(raw,FileDispositionInfo,&disposition,sizeof(disposition)));removed++;}
      else{check(CfRevertPlaceholder(h.h,CF_REVERT_FLAG_NONE,nullptr));kept++;}notifyShell(entry.path);break;
      }catch(winrt::hresult_error const& error){auto hr=error.code().value;if(attempt>=49||(hr!=HRESULT_FROM_WIN32(ERROR_OPLOCK_HANDLE_CLOSED)&&hr!=HRESULT_FROM_WIN32(ERROR_SHARING_VIOLATION)&&hr!=HRESULT_FROM_WIN32(ERROR_LOCK_VIOLATION)&&hr!=HRESULT_FROM_WIN32(ERROR_INVALID_HANDLE)))throw;std::this_thread::sleep_for(std::chrono::milliseconds(20));}
    }
    resetCheck();unregisterRoot();JsonObject completed;put(completed,L"root",utf(root));put(completed,L"owner",owner);auto record=utf(completed.Stringify().c_str());Handle marker(CreateFileW(cached(utf((fs::path(cacheRoot)/L"reset-complete.json").wstring())).c_str(),GENERIC_WRITE,0,nullptr,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,nullptr));wincheck(marker.h!=INVALID_HANDLE_VALUE);DWORD written=0;wincheck(WriteFile(marker.h,record.data(),static_cast<DWORD>(record.size()),&written,nullptr));if(written!=record.size())winrt::throw_hresult(HRESULT_FROM_WIN32(ERROR_WRITE_FAULT));wincheck(FlushFileBuffers(marker.h));putn(result,L"kept",kept);putn(result,L"removed",removed);return result;
  }
  if(action=="detach"){
    std::lock_guard<std::mutex> lock(mutationMutex);std::map<std::wstring,std::string> known;for(auto const& value:cmd.GetNamedArray(L"items")){auto item=value.GetObject();known[lower(full(str(item,L"path")))]=str(item,L"identity");}
    std::vector<std::wstring> placeholders;
    for(auto const& entry:fs::recursive_directory_iterator(root)){
      auto p=entry.path().wstring();std::unique_ptr<Handle> h(attributes(p));FILE_ATTRIBUTE_TAG_INFO tag{};wincheck(GetFileInformationByHandleEx(h->h,FileAttributeTagInfo,&tag,sizeof(tag)));auto state=CfGetPlaceholderStateFromAttributeTag(tag.FileAttributes,tag.ReparseTag);
      if(state&CF_PLACEHOLDER_STATE_PLACEHOLDER){auto found=known.find(lower(p));if(found==known.end())winrt::throw_hresult(E_ACCESSDENIED);requireOwned(h->h,found->second);placeholders.push_back(p);}
      else if(tag.FileAttributes&FILE_ATTRIBUTE_REPARSE_POINT)winrt::throw_hresult(E_ACCESSDENIED);
    }
    // Hydrate every owned file before reverting any: failure leaves the provider recoverable.
    for(auto const& p:placeholders)if(!(GetFileAttributesW(p.c_str())&FILE_ATTRIBUTE_DIRECTORY)){std::unique_ptr<Handle> h(attributes(p));requireOwned(h->h,known.at(lower(p)));check(CfSetPinState(h->h,CF_PIN_STATE_PINNED,CF_SET_PIN_FLAG_NONE,nullptr));LARGE_INTEGER zero{},end;end.QuadPart=CF_EOF;check(CfHydratePlaceholder(h->h,zero,end,CF_HYDRATE_FLAG_NONE,nullptr));}
    std::sort(placeholders.begin(),placeholders.end(),[](auto const& a,auto const& b){return a.size()>b.size();});
    for(auto const& p:placeholders){Protected h(p);requireOwned(CfGetWin32HandleFromProtectedHandle(h.h),known.at(lower(p)));check(CfRevertPlaceholder(h.h,CF_REVERT_FLAG_NONE,nullptr));notifyShell(p);}
    unregisterRoot();return result;
  }
  if(action=="create"){
    std::lock_guard<std::mutex> lock(mutationMutex);auto p=full(str(cmd,L"path"));auto identity=str(cmd,L"identity");if(identity.empty()||identity.size()>4096)winrt::throw_hresult(E_INVALIDARG);
    if(GetFileAttributesW(p.c_str())!=INVALID_FILE_ATTRIBUTES){std::unique_ptr<Handle> h(attributes(p));requireOwned(h->h,identity);return inspectPath(cmd);}
    auto relative=fs::path(p).filename().wstring(),parent=fs::path(p).parent_path().wstring();if(!fs::is_directory(parent))winrt::throw_hresult(E_INVALIDARG);
    CF_PLACEHOLDER_CREATE_INFO info{};info.RelativeFileName=relative.c_str();info.FsMetadata=metadata(cmd);info.FileIdentity=identity.data();info.FileIdentityLength=static_cast<DWORD>(identity.size());info.Flags=CF_PLACEHOLDER_CREATE_FLAG_MARK_IN_SYNC|CF_PLACEHOLDER_CREATE_FLAG_DISABLE_ON_DEMAND_POPULATION;DWORD processed=0;check(CfCreatePlaceholders(parent.c_str(),&info,1,CF_CREATE_FLAG_STOP_ON_ERROR,&processed));check(info.Result);notifyShell(p);return inspectPath(cmd);
  }
  if(action=="supply"||action=="fail"||action=="ack"){
    Request request;auto id=str(cmd,L"request");{std::lock_guard<std::mutex> lock(requestsMutex);auto found=requests.find(id);if(found==requests.end())winrt::throw_hresult(HRESULT_FROM_WIN32(ERROR_OPERATION_ABORTED));request=found->second;if(action!="supply"||jsonBool(cmd,L"final"))requests.erase(found);}
    if(action=="ack"){ack(request.info,jsonBool(cmd,L"allow")?0:deniedStatus);return result;}
    CF_OPERATION_PARAMETERS p{};p.ParamSize=CF_SIZE_OF_OP_PARAM(TransferData);p.TransferData.Offset.QuadPart=static_cast<LONGLONG>(num(cmd,L"offset",static_cast<double>(request.offset)));
    std::vector<char> buffer;
    if(action=="fail"){p.TransferData.CompletionStatus=failedStatus;p.TransferData.Length.QuadPart=request.length;}
    else{auto filename=cached(str(cmd,L"file"));std::ifstream stream(filename,std::ios::binary);if(!stream)winrt::throw_hresult(E_ACCESSDENIED);stream.seekg(0,std::ios::end);auto size=static_cast<size_t>(stream.tellg());if(size>4*1024*1024)winrt::throw_hresult(E_INVALIDARG);stream.seekg(0);buffer.resize(size);stream.read(buffer.data(),size);if(static_cast<size_t>(stream.gcount())!=size)winrt::throw_hresult(E_FAIL);p.TransferData.Buffer=buffer.data();p.TransferData.Length.QuadPart=static_cast<LONGLONG>(size);}
    auto hr=CfExecute(&request.info,&p);if(!request.path.empty()){bool more=false;{std::lock_guard<std::mutex> lock(requestsMutex);more=std::any_of(requests.begin(),requests.end(),[&](auto const& entry){return entry.second.path==request.path;});}auto completed=std::min(request.size,p.TransferData.Offset.QuadPart+p.TransferData.Length.QuadPart);LARGE_INTEGER total{},done{};total.QuadPart=request.size;done.QuadPart=completed;if(action=="supply")CfReportProviderProgress(request.info.ConnectionKey,request.info.TransferKey,total,done);transferState(request.path,more,action=="supply"?completed:0,request.size);}check(hr);return result;
  }
  if(action=="folderAvailability"){
    auto p=full(str(cmd,L"path"));if(!(GetFileAttributesW(p.c_str())&FILE_ATTRIBUTE_DIRECTORY))winrt::throw_hresult(E_INVALIDARG);
    std::unique_ptr<Handle> h(attributes(p));requireOwned(h->h,str(cmd,L"identity"));auto bytes=placeholderInfo(h->h);auto* info=reinterpret_cast<CF_PLACEHOLDER_STANDARD_INFO*>(bytes.data());auto desired=str(cmd,L"mode")=="local"?CF_PIN_STATE_PINNED:CF_PIN_STATE_UNPINNED;
    // Pin intent is synchronized by Cloud Files; it needs no exclusive oplock.
    if(info->PinState!=desired){check(CfSetPinState(h->h,desired,CF_SET_PIN_FLAG_NONE,nullptr));notifyShell(p);}return result;
  }
  if(action=="availability"){
    auto p=full(str(cmd,L"path"));auto identity=str(cmd,L"identity");
    if(str(cmd,L"mode")=="local"){std::unique_ptr<Handle> h(attributes(p));requireOwned(h->h,identity);check(CfSetPinState(h->h,CF_PIN_STATE_PINNED,CF_SET_PIN_FLAG_NONE,nullptr));LARGE_INTEGER zero{},end;end.QuadPart=CF_EOF;check(CfHydratePlaceholder(h->h,zero,end,CF_HYDRATE_FLAG_NONE,nullptr));}
    else{Protected h(p);auto raw=CfGetWin32HandleFromProtectedHandle(h.h);requireOwned(raw,identity);auto bytes=placeholderInfo(raw);auto* info=reinterpret_cast<CF_PLACEHOLDER_STANDARD_INFO*>(bytes.data());if(info->InSyncState!=CF_IN_SYNC_STATE_IN_SYNC||info->ModifiedDataSize.QuadPart)winrt::throw_hresult(HRESULT_FROM_WIN32(ERROR_CLOUD_FILE_NOT_IN_SYNC));check(CfSetPinState(h.h,CF_PIN_STATE_UNPINNED,CF_SET_PIN_FLAG_NONE,nullptr));LARGE_INTEGER zero{},end;end.QuadPart=CF_EOF;check(CfDehydratePlaceholder(h.h,zero,end,CF_DEHYDRATE_FLAG_NONE,nullptr));}notifyShell(p);return inspectPath(cmd);
  }
  if(action=="update"){
    std::lock_guard<std::mutex> lock(mutationMutex);auto p=full(str(cmd,L"path"));Protected h(p);auto raw=CfGetWin32HandleFromProtectedHandle(h.h);requireOwned(raw,str(cmd,L"previousIdentity"));auto bytes=placeholderInfo(raw);auto* info=reinterpret_cast<CF_PLACEHOLDER_STANDARD_INFO*>(bytes.data());if(info->InSyncState!=CF_IN_SYNC_STATE_IN_SYNC||info->ModifiedDataSize.QuadPart)winrt::throw_hresult(HRESULT_FROM_WIN32(ERROR_CLOUD_FILE_NOT_IN_SYNC));
    check(CfSetPinState(h.h,CF_PIN_STATE_UNSPECIFIED,CF_SET_PIN_FLAG_NONE,nullptr));auto identity=str(cmd,L"identity");auto m=metadata(cmd);check(CfUpdatePlaceholder(h.h,&m,identity.data(),static_cast<DWORD>(identity.size()),nullptr,0,CF_UPDATE_FLAG_VERIFY_IN_SYNC|CF_UPDATE_FLAG_MARK_IN_SYNC|CF_UPDATE_FLAG_DEHYDRATE,nullptr,nullptr));return result;
  }
  if(action=="snapshot"){
    auto p=full(str(cmd,L"path")),destination=cached(str(cmd,L"file"));auto state=inspectPath(cmd);if(jsonBool(state,L"directory")||(jsonBool(state,L"placeholder")&&(jsonBool(state,L"partial")||num(state,L"onDisk")<num(state,L"size"))))winrt::throw_hresult(E_ACCESSDENIED);
    Handle source(CreateFileW(p.c_str(),GENERIC_READ,FILE_SHARE_READ,nullptr,OPEN_EXISTING,FILE_FLAG_SEQUENTIAL_SCAN,nullptr));wincheck(source.h!=INVALID_HANDLE_VALUE);auto before=stamp(source.h);Handle target(CreateFileW(destination.c_str(),GENERIC_WRITE,0,nullptr,CREATE_NEW,FILE_ATTRIBUTE_TEMPORARY,nullptr));wincheck(target.h!=INVALID_HANDLE_VALUE);std::vector<char> buffer(1024*1024);DWORD read=0;while(true){wincheck(ReadFile(source.h,buffer.data(),static_cast<DWORD>(buffer.size()),&read,nullptr));if(!read)break;DWORD written=0;wincheck(WriteFile(target.h,buffer.data(),read,&written,nullptr)&&written==read);}wincheck(FlushFileBuffers(target.h));put(result,L"stamp",before);putn(result,L"modified",num(state,L"modified"));putn(result,L"size",num(state,L"size"));return result;
  }
  if(action=="markMetadata"){
    auto p=full(str(cmd,L"path"));Handle h(CreateFileW(p.c_str(),FILE_READ_ATTRIBUTES|FILE_WRITE_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT|FILE_FLAG_BACKUP_SEMANTICS,nullptr));wincheck(h.h!=INVALID_HANDLE_VALUE);requireOwned(h.h,str(cmd,L"previousIdentity"));auto bytes=placeholderInfo(h.h);auto* info=reinterpret_cast<CF_PLACEHOLDER_STANDARD_INFO*>(bytes.data());FILE_STANDARD_INFO file{};wincheck(GetFileInformationByHandleEx(h.h,FileStandardInfo,&file,sizeof(file)));auto b=basic(h.h);double modified=(b.LastWriteTime.QuadPart-116444736000000000LL)/10000.0;
    if(info->ModifiedDataSize.QuadPart||(!jsonBool(cmd,L"directory")&&(file.EndOfFile.QuadPart!=static_cast<LONGLONG>(num(cmd,L"size"))||std::abs(modified-num(cmd,L"modified"))>1000)))winrt::throw_hresult(E_ACCESSDENIED);auto next=str(cmd,L"identity");check(CfUpdatePlaceholder(h.h,nullptr,next.data(),static_cast<DWORD>(next.size()),nullptr,0,CF_UPDATE_FLAG_MARK_IN_SYNC,nullptr,nullptr));return result;
  }
  if(action=="commit"){
    std::lock_guard<std::mutex> lock(mutationMutex);auto p=full(str(cmd,L"path"));Handle raw(CreateFileW(p.c_str(),FILE_READ_DATA|FILE_READ_ATTRIBUTES|FILE_WRITE_ATTRIBUTES,FILE_SHARE_READ,nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT|FILE_FLAG_BACKUP_SEMANTICS,nullptr));wincheck(raw.h!=INVALID_HANDLE_VALUE);if(stamp(raw.h)!=str(cmd,L"stamp")){putb(result,L"committed",false);return result;}
    auto identity=str(cmd,L"identity");FILE_ATTRIBUTE_TAG_INFO tag{};wincheck(GetFileInformationByHandleEx(raw.h,FileAttributeTagInfo,&tag,sizeof(tag)));auto state=CfGetPlaceholderStateFromAttributeTag(tag.FileAttributes,tag.ReparseTag);
    if(state&CF_PLACEHOLDER_STATE_PLACEHOLDER){requireOwned(raw.h,str(cmd,L"previousIdentity"));check(CfUpdatePlaceholder(raw.h,nullptr,identity.data(),static_cast<DWORD>(identity.size()),nullptr,0,CF_UPDATE_FLAG_MARK_IN_SYNC,nullptr,nullptr));}
    else check(CfConvertToPlaceholder(raw.h,identity.data(),static_cast<DWORD>(identity.size()),CF_CONVERT_FLAG_MARK_IN_SYNC,nullptr,nullptr));putb(result,L"committed",true);notifyShell(p);return result;
  }
  if(action=="moveLocal"||action=="remove"){
    std::lock_guard<std::mutex> lock(mutationMutex);auto p=full(str(cmd,L"path"));{std::unique_ptr<Handle> h(attributes(p));requireOwned(h->h,str(cmd,L"identity"));auto bytes=placeholderInfo(h->h);auto* info=reinterpret_cast<CF_PLACEHOLDER_STANDARD_INFO*>(bytes.data());if(info->InSyncState!=CF_IN_SYNC_STATE_IN_SYNC||info->ModifiedDataSize.QuadPart)winrt::throw_hresult(HRESULT_FROM_WIN32(ERROR_CLOUD_FILE_NOT_IN_SYNC));}
    if(action=="moveLocal"){auto target=full(str(cmd,L"target"));wincheck(MoveFileExW(p.c_str(),target.c_str(),MOVEFILE_WRITE_THROUGH));}
    else{auto attr=GetFileAttributesW(p.c_str());if(attr&FILE_ATTRIBUTE_DIRECTORY)wincheck(RemoveDirectoryW(p.c_str()));else wincheck(DeleteFileW(p.c_str()));}return result;
  }
  if(action=="unregister"){std::lock_guard<std::mutex> lock(mutationMutex);if(!fs::is_empty(root))winrt::throw_hresult(HRESULT_FROM_WIN32(ERROR_DIR_NOT_EMPTY));unregisterRoot();return result;}
  winrt::throw_hresult(E_INVALIDARG);
}
int main(){
  winrt::init_apartment(winrt::apartment_type::multi_threaded);SetErrorMode(SEM_FAILCRITICALERRORS|SEM_NOGPFAULTERRORBOX);
  std::atomic<unsigned> active{0};std::mutex finishedMutex;std::condition_variable finished;std::string line;
  while(std::getline(std::cin,line)){
    if(line.size()>16*1024*1024)break;
    try{auto command=JsonObject::Parse(winrt::to_hstring(line));if(str(command,L"command")=="shutdown")break;
      active++;std::thread([command,&active,&finished](){winrt::init_apartment(winrt::apartment_type::multi_threaded);JsonObject response;put(response,L"id",str(command,L"id"));try{auto data=handleCommand(command);putb(response,L"ok",true);response.Insert(L"data",data);}catch(winrt::hresult_error const& error){putb(response,L"ok",false);std::ostringstream code;code<<"0x"<<std::hex<<static_cast<unsigned long>(error.code().value);put(response,L"error",code.str());if(!commandStage.empty())put(response,L"stage",commandStage);}catch(std::exception const&){putb(response,L"ok",false);put(response,L"error","native.operation");if(!commandStage.empty())put(response,L"stage",commandStage);}catch(...){putb(response,L"ok",false);put(response,L"error","native.operation");}emit(response);active--;finished.notify_all();}).detach();
    }catch(...){break;}
  }
  stopping=true;if(connected){CfDisconnectSyncRoot(connection);connected=false;}std::unique_lock<std::mutex> guard(finishedMutex);finished.wait(guard,[&active](){return active.load()==0;});return 0;
}
