const c={dt:process.env.GOOGLE_ADS_DEVELOPER_TOKEN,id:process.env.GOOGLE_ADS_CLIENT_ID,s:process.env.GOOGLE_ADS_CLIENT_SECRET,r:process.env.GOOGLE_ADS_REFRESH_TOKEN,l:(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID||"").replace(/-/g,"")};
const at=(await (await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({client_id:c.id,client_secret:c.s,refresh_token:c.r,grant_type:"refresh_token"})})).json()).access_token;
const H={Authorization:`Bearer ${at}`,"developer-token":c.dt,"login-customer-id":c.l,"Content-Type":"application/json"};
const id="6001698719";
const ops=[
 {update:{resourceName:"customers/6001698719/campaignBudgets/13225239491",amountMicros:"15900000000"},updateMask:"amount_micros"},
 {update:{resourceName:"customers/6001698719/campaignBudgets/14946760493",amountMicros:"9450000000"},updateMask:"amount_micros"},
];
const r=await fetch(`https://googleads.googleapis.com/v24/customers/${id}/campaignBudgets:mutate`,{method:"POST",headers:H,body:JSON.stringify({operations:ops})});
const mut=await r.json();
const rb=await fetch(`https://googleads.googleapis.com/v24/customers/${id}/googleAds:searchStream`,{method:"POST",headers:H,body:JSON.stringify({query:"SELECT campaign.name, campaign_budget.amount_micros FROM campaign WHERE campaign.id IN (20870572219,23048708836)"})});
process.stdout.write(JSON.stringify({status:r.status,mut,readback:await rb.json()}));
