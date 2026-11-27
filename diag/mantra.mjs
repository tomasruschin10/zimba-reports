const c={dt:process.env.GOOGLE_ADS_DEVELOPER_TOKEN,id:process.env.GOOGLE_ADS_CLIENT_ID,s:process.env.GOOGLE_ADS_CLIENT_SECRET,r:process.env.GOOGLE_ADS_REFRESH_TOKEN,l:(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID||"").replace(/-/g,"")};
const at=(await (await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({client_id:c.id,client_secret:c.s,refresh_token:c.r,grant_type:"refresh_token"})})).json()).access_token;
async function q(cid,query){const r=await fetch(`https://googleads.googleapis.com/v24/customers/${cid}/googleAds:searchStream`,{method:"POST",headers:{Authorization:`Bearer ${at}`,"developer-token":c.dt,"login-customer-id":c.l,"Content-Type":"application/json"},body:JSON.stringify({query})});const b=await r.json();if(!r.ok)return{error:JSON.stringify(b).slice(0,500)};return(Array.isArray(b)?b:[b]).flatMap(x=>x.results||[]);}
const id="6001698719";
const out={
 actions:await q(id,"SELECT conversion_action.name, conversion_action.status, conversion_action.type, conversion_action.include_in_conversions_metric, conversion_action.counting_type FROM conversion_action WHERE conversion_action.status = 'ENABLED'"),
 byday:await q(id,"SELECT segments.date, segments.conversion_action_name, metrics.all_conversions, metrics.all_conversions_value FROM customer WHERE segments.date BETWEEN '2026-11-20' AND '2026-11-27'"),
 bydayconv:await q(id,"SELECT segments.date, metrics.cost_micros, metrics.conversions, metrics.conversions_value FROM customer WHERE segments.date BETWEEN '2026-11-20' AND '2026-11-27'"),
 changes:await q(id,"SELECT change_event.change_date_time, change_event.change_resource_type, change_event.resource_change_operation, change_event.user_email, change_event.changed_fields FROM change_event WHERE change_event.change_date_time >= '2026-11-10' AND change_event.change_resource_type = 'CONVERSION_ACTION' ORDER BY change_event.change_date_time DESC LIMIT 20"),
};
process.stdout.write(JSON.stringify(out));
