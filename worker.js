// Paste this into the Cloudflare Worker editor.
// It keeps the existing AI, D1 account system and ESP32 KV channel,
// and adds a timestamped ESP32 heartbeat.

const DEVICE_ID = "JARVIS-ESP32-01";
const AI_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";
const FRONTEND_ORIGIN = "https://harsh-grc-2026.github.io";

const corsHeaders = {
  "Access-Control-Allow-Origin": FRONTEND_ORIGIN,
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400"
};

const SYSTEM_PROMPT = `
You are JARVIS, a personal AI assistant.
Personality:
- Calm
- Intelligent
- Helpful
- Concise
- Professional
- Friendly
Rules:
- Answer the user's question directly.
- Do not invent conversations.
- Do not repeat the user's question.
- Keep simple answers short.
- Give practical answers for engineering and robotics questions.
- Do not create unnecessary numbered lists.
- Do not generate unrelated examples.
`;

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {
      const url = new URL(request.url);

      if (url.pathname === "/" && request.method === "GET") {
        return json({ status: "online", service: "JARVIS AI", ai: "Llama 3.1 8B", database: "D1", device_channel: "online" });
      }

      if (url.pathname === "/auth/register" && request.method === "POST") return await register(request, env);
      if (url.pathname === "/auth/login" && request.method === "POST") return await login(request, env);
      if (url.pathname === "/auth/logout" && request.method === "POST") return await logout(request, env);

      if (url.pathname === "/auth/me" && request.method === "GET") {
        const user = await authenticate(request, env);
        if (!user) return json({ authenticated: false }, 401);
        return json({ authenticated: true, user });
      }

      if (url.pathname === "/conversations" && request.method === "GET") {
        const user = await authenticate(request, env);
        if (!user) return json({ error: "Unauthorized" }, 401);
        const result = await env.DB.prepare(`SELECT id,title,created_at,updated_at FROM conversations WHERE user_id=? ORDER BY updated_at DESC`).bind(user.id).all();
        return json({ conversations: result.results || [] });
      }

      if (url.pathname === "/conversations" && request.method === "POST") {
        const user = await authenticate(request, env);
        if (!user) return json({ error: "Unauthorized" }, 401);
        const body = await request.json();
        const title = String(body.title || "New Conversation").trim().slice(0, 100);
        const id = crypto.randomUUID();
        const now = Date.now();
        await env.DB.prepare(`INSERT INTO conversations (id,user_id,title,created_at,updated_at) VALUES (?,?,?,?,?)`).bind(id,user.id,title,now,now).run();
        return json({ success:true, conversation:{id,title,created_at:now,updated_at:now} });
      }

      const conversationMatch = url.pathname.match(/^\/conversations\/([^/]+)$/);
      if (conversationMatch && request.method === "GET") {
        const user = await authenticate(request, env);
        if (!user) return json({ error:"Unauthorized" },401);
        const id = conversationMatch[1];
        const conversation = await env.DB.prepare(`SELECT id,title,created_at,updated_at FROM conversations WHERE id=? AND user_id=?`).bind(id,user.id).first();
        if (!conversation) return json({ error:"Conversation not found" },404);
        const messages = await env.DB.prepare(`SELECT id,role,content,created_at FROM messages WHERE conversation_id=? AND user_id=? ORDER BY created_at ASC`).bind(id,user.id).all();
        return json({ conversation, messages:messages.results || [] });
      }

      if (url.pathname === "/ask" && request.method === "POST") {
        const body = await request.json();
        if (!body.prompt) return json({error:"No prompt provided"},400);
        const promptText = String(body.prompt).trim();
        const prompt = promptText.toLowerCase();

        if (["turn on the led","turn on led","switch on the led","switch on led","led on","turn the led on"].some(x=>prompt.includes(x))) {
          await env.Devices.put("command:"+DEVICE_ID,"LED_ON",{expirationTtl:60});
          return json({response:"LED turned on.",device:DEVICE_ID,command:"LED_ON"});
        }
        if (["turn off the led","turn off led","switch off the led","switch off led","led off","turn the led off"].some(x=>prompt.includes(x))) {
          await env.Devices.put("command:"+DEVICE_ID,"LED_OFF",{expirationTtl:60});
          return json({response:"LED turned off.",device:DEVICE_ID,command:"LED_OFF"});
        }

        const user = await authenticate(request,env);
        let conversationId = body.conversation_id || null;

        if (user && !conversationId) {
          conversationId=crypto.randomUUID();
          const now=Date.now();
          await env.DB.prepare(`INSERT INTO conversations (id,user_id,title,created_at,updated_at) VALUES (?,?,?,?,?)`).bind(conversationId,user.id,promptText.replace(/\s+/g," ").slice(0,60)||"New Conversation",now,now).run();
        }

        if (user && conversationId) {
          const owned=await env.DB.prepare(`SELECT id FROM conversations WHERE id=? AND user_id=?`).bind(conversationId,user.id).first();
          if (!owned) return json({error:"Conversation not found"},404);
          await env.DB.prepare(`INSERT INTO messages (id,conversation_id,user_id,role,content,created_at) VALUES (?,?,?,?,?,?)`).bind(crypto.randomUUID(),conversationId,user.id,"user",promptText,Date.now()).run();
        }

        const messages=[{role:"system",content:SYSTEM_PROMPT}];
        if(user && conversationId){
          const history=await env.DB.prepare(`SELECT role,content FROM messages WHERE conversation_id=? AND user_id=? ORDER BY created_at DESC LIMIT 20`).bind(conversationId,user.id).all();
          for(const m of (history.results||[]).reverse()) messages.push({role:m.role,content:m.content});
        } else messages.push({role:"user",content:promptText});

        const result=await env.AI.run(AI_MODEL,{messages,max_tokens:200,temperature:0.4,top_p:0.9,repetition_penalty:1.1});
        const response=result.response||"I couldn't generate a response.";

        if(user && conversationId){
          await env.DB.prepare(`INSERT INTO messages (id,conversation_id,user_id,role,content,created_at) VALUES (?,?,?,?,?,?)`).bind(crypto.randomUUID(),conversationId,user.id,"assistant",response,Date.now()).run();
          await env.DB.prepare(`UPDATE conversations SET updated_at=? WHERE id=? AND user_id=?`).bind(Date.now(),conversationId,user.id).run();
        }
        return json({response,conversation_id:conversationId});
      }

      if (url.pathname === "/device/command" && request.method === "GET") {
        const device=url.searchParams.get("device");
        if(!device) return json({error:"Device ID missing"},400);
        const key="command:"+device;
        const command=await env.Devices.get(key);
        if(!command) return json({command:"none"});
        await env.Devices.delete(key);
        return json({command});
      }

      if (url.pathname === "/device/command" && request.method === "POST") {
        const body=await request.json();
        if(!body.device) return json({error:"Device ID missing"},400);
        if(!body.command) return json({error:"Command missing"},400);
        await env.Devices.put("command:"+body.device,String(body.command),{expirationTtl:60});
        return json({success:true,device:body.device,command:body.command});
      }

      // ======================================================
      // ESP32 HEARTBEAT - IMPORTANT FIX
      // ======================================================
      if (url.pathname === "/device/status" && request.method === "POST") {
        const body=await request.json();
        if(!body.device) return json({error:"Device ID missing"},400);

        const statusData={
          device:String(body.device),
          online:body.online === true,
          ip:body.ip || null,
          rssi:body.rssi ?? null,
          uptime:body.uptime ?? null,
          last_seen:Date.now()
        };

        await env.Devices.put(
          "status:"+body.device,
          JSON.stringify(statusData),
          {expirationTtl:120}
        );

        return json({success:true,status:statusData});
      }

      // ======================================================
      // ESP32 STATUS READ
      // ======================================================
      if (url.pathname === "/device/status" && request.method === "GET") {
        const device=url.searchParams.get("device");
        if(!device) return json({error:"Device ID missing"},400);
        const raw=await env.Devices.get("status:"+device);
        if(!raw) return json({online:false,device});

        let status;
        try { status=JSON.parse(raw); } catch { return json({online:false,device}); }

        const age=Date.now()-Number(status.last_seen||0);
        if(status.online !== true || age < 0 || age >= 120000) {
          return json({online:false,device,last_seen:status.last_seen||null});
        }

        return json({...status,online:true,age_ms:age});
      }

      return json({error:"Not found"},404);
    } catch(error) {
      console.error(error);
      return json({error:error.message||"Internal server error"},500);
    }
  }
};

async function register(request,env){
  const body=await request.json();
  const name=String(body.name||"").trim();
  const email=String(body.email||"").trim().toLowerCase();
  const password=String(body.password||"");
  if(!name)return json({error:"Name is required"},400);
  if(!email||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return json({error:"Invalid email address"},400);
  if(password.length<8)return json({error:"Password must be at least 8 characters"},400);
  const existing=await env.DB.prepare(`SELECT id FROM users WHERE email=?`).bind(email).first();
  if(existing)return json({error:"An account with this email already exists"},409);
  const id=crypto.randomUUID(),now=Date.now();
  const passwordHash=await hashPassword(password);
  await env.DB.prepare(`INSERT INTO users (id,name,email,password_hash,created_at,updated_at) VALUES (?,?,?,?,?,?)`).bind(id,name,email,passwordHash,now,now).run();
  const token=await createSession(id,env);
  return json({success:true,user:{id,name,email},token});
}

async function login(request,env){
  const body=await request.json();
  const email=String(body.email||"").trim().toLowerCase();
  const password=String(body.password||"");
  if(!email||!password)return json({error:"Email and password are required"},400);
  const user=await env.DB.prepare(`SELECT id,name,email,password_hash FROM users WHERE email=?`).bind(email).first();
  if(!user||!(await verifyPassword(password,user.password_hash)))return json({error:"Invalid email or password"},401);
  const token=await createSession(user.id,env);
  return json({success:true,user:{id:user.id,name:user.name,email:user.email},token});
}

async function logout(request,env){
  const token=getAuthToken(request);
  if(token) await env.DB.prepare(`DELETE FROM sessions WHERE id=?`).bind(await hashToken(token)).run();
  return json({success:true});
}

async function authenticate(request,env){
  const token=getAuthToken(request);
  if(!token)return null;
  const user=await env.DB.prepare(`SELECT u.id,u.name,u.email FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND s.expires_at>?`).bind(await hashToken(token),Date.now()).first();
  return user||null;
}

async function createSession(userId,env){
  const bytes=new Uint8Array(32);crypto.getRandomValues(bytes);
  const token=bytesToBase64Url(bytes),id=await hashToken(token),now=Date.now(),expires=now+30*24*60*60*1000;
  await env.DB.prepare(`INSERT INTO sessions (id,user_id,expires_at,created_at) VALUES (?,?,?,?)`).bind(id,userId,expires,now).run();
  return token;
}

async function hashPassword(password){
  const salt=new Uint8Array(16);crypto.getRandomValues(salt);
  const iterations=100000;
  const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(password),{name:"PBKDF2"},false,["deriveBits"]);
  const bits=await crypto.subtle.deriveBits({name:"PBKDF2",salt,iterations,hash:"SHA-256"},key,256);
  return ["pbkdf2",iterations,bytesToBase64Url(salt),bytesToBase64Url(new Uint8Array(bits))].join("$");
}

async function verifyPassword(password,stored){
  try{
    const p=stored.split("$");if(p.length!==4||p[0]!=="pbkdf2")return false;
    const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(password),{name:"PBKDF2"},false,["deriveBits"]);
    const bits=await crypto.subtle.deriveBits({name:"PBKDF2",salt:base64UrlToBytes(p[2]),iterations:Number(p[1]),hash:"SHA-256"},key,256);
    return constantTimeEqual(new Uint8Array(bits),base64UrlToBytes(p[3]));
  }catch{return false;}
}

async function hashToken(token){
  const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(token));
  return bytesToHex(new Uint8Array(digest));
}

function getAuthToken(request){
  const h=request.headers.get("Authorization");
  return h&&h.startsWith("Bearer ")?h.substring(7).trim():null;
}

function constantTimeEqual(a,b){if(a.length!==b.length)return false;let r=0;for(let i=0;i<a.length;i++)r|=a[i]^b[i];return r===0;}
function bytesToHex(bytes){return Array.from(bytes).map(b=>b.toString(16).padStart(2,"0")).join("");}
function bytesToBase64Url(bytes){let s="";for(const b of bytes)s+=String.fromCharCode(b);return btoa(s).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");}
function base64UrlToBytes(v){let s=v.replace(/-/g,"+").replace(/_/g,"/");while(s.length%4)s+="=";const b=atob(s),a=new Uint8Array(b.length);for(let i=0;i<b.length;i++)a[i]=b.charCodeAt(i);return a;}
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json",...corsHeaders}});}
