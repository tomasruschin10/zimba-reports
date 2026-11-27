const c={dt:process.env.GOOGLE_ADS_DEVELOPER_TOKEN,id:process.env.GOOGLE_ADS_CLIENT_ID,s:process.env.GOOGLE_ADS_CLIENT_SECRET,r:process.env.GOOGLE_ADS_REFRESH_TOKEN,l:(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID||"").replace(/-/g,"")};
const at=(await (await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({client_id:c.id,client_secret:c.s,refresh_token:c.r,grant_type:"refresh_token"})})).json());
async function q(cid,query){const r=await fetch(`https://googleads.googleapis.com/v24/customers/${cid}/googleAds:searchStream`,{method:"POST",headers:{Authorization:`Bearer ${at.access_token}`,"developer-token":c.dt,"login-customer-id":c.l,"Content-Type":"application/json"},body:JSON.stringify({query})});const b=await r.json();if(!r.ok)return{error:JSON.stringify(b).slice(0,500)};return(Array.isArray(b)?b:[b]).flatMap(x=>x.results||[]);}
const id="6001698719";
const out={scope:at.scope,
 budgets:await q(id,"SELECT campaign.id, campaign.name, campaign.status, campaign_budget.resource_name, campaign_budget.amount_micros, campaign_budget.explicitly_shared, campaign_budget.reference_count FROM campaign WHERE campaign.status='ENABLED'"),
 aga:await q(id,"SELECT asset_group.name, asset_group_asset.resource_name, asset_group_asset.field_type, asset_group_asset.status, asset.text_asset.text FROM asset_group_asset WHERE asset_group.name = 'Promociones Mantra' AND asset_group_asset.status != 'REMOVED'"),
 rsa:await q(id,"SELECT campaign.name, ad_group.name, ad_group_ad.resource_name, ad_group_ad.ad.resource_name, ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions, ad_group_ad.ad.final_urls FROM ad_group_ad WHERE ad_group_ad.status='ENABLED' AND campaign.status='ENABLED' AND ad_group.status='ENABLED' AND ad_group_ad.ad.type='RESPONSIVE_SEARCH_AD'"),
};
process.stdout.write(JSON.stringify(out));
