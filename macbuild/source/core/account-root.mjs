export function accountRootScope(profile){
  const info=profile?.root_info;if(typeof info?.root_namespace_id!=='string'||!info.root_namespace_id||typeof info.home_namespace_id!=='string'||!info.home_namespace_id)throw new Error('err.accountRoot');
  return info.root_namespace_id===info.home_namespace_id?'personal':'team';
}
export function currentConfigAccessToken(config,now=Date.now()){
  try{const token=JSON.parse(config.match(/^token\s*=\s*(.+)$/m)?.[1]||'null');if(typeof token?.access_token==='string'&&Date.parse(token.expiry)>now+60000)return token.access_token;}catch{/* rclone refreshes missing, expired or malformed token data. */}
  return null;
}
