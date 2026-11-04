#include <windows.h>
#include <filesystem>
#include <string>
#include <vector>

int WINAPI wWinMain(HINSTANCE,HINSTANCE,PWSTR arguments,int){
  std::vector<wchar_t> module(32768);DWORD length=GetModuleFileNameW(nullptr,module.data(),static_cast<DWORD>(module.size()));
  if(!length||length>=module.size())return 1;
  const auto application=(std::filesystem::path(module.data()).parent_path()/L"app"/L"AMG rclone UI.exe");
  std::wstring command=L"\""+application.wstring()+L"\"";
  if(arguments&&*arguments){command+=L" ";command+=arguments;}
  SetEnvironmentVariableW(L"ELECTRON_RUN_AS_NODE",nullptr);
  STARTUPINFOW startup{};startup.cb=sizeof(startup);PROCESS_INFORMATION process{};
  auto directory=application.parent_path().wstring();
  if(!CreateProcessW(application.c_str(),command.data(),nullptr,nullptr,FALSE,0,nullptr,directory.c_str(),&startup,&process)){
    MessageBoxW(nullptr,L"Не вдалося запустити AMG rclone UI. Перевірте, що підпапка app міститься поруч із цим EXE.",L"AMG rclone UI",MB_OK|MB_ICONERROR);return 1;
  }
  CloseHandle(process.hThread);CloseHandle(process.hProcess);return 0;
}
