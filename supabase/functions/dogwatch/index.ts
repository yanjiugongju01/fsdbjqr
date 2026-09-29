// Supabase Edge Function: dog-watch 飞书机器人
// 架构：dog-watch 只做"指令门面"（零token），实际搬运/朗读由云电脑扫描喇叭群执行。
//
// 指令识别：
//  - "朗读 <链接>" → 回"收到" + 把 [朗读] 内部指令发到喇叭群中转
//  - "转发 <内容> 到 <群>" → 回"收到" + 把 [转发] 内部指令发到喇叭群中转
//  - 其他 → 回"收到"（默认），不做多余动作
//
// 云电脑定时任务扫描喇叭群，看到 [朗读]/[转发] 前缀 → 用你的飞书身份执行。
// 这样 dog-watch 不跑 edge-tts（避免 BOOT_ERROR），不耗 token，无权限问题。

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-request-id, x-lark-signature",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// 喇叭群作为中转群（dog-watch 已在该群）
const RELAY_CHAT_ID = "oc_23ae2d7c114f225480d53b5e74ccf37d";

// 获取飞书 tenant_access_token
async function getTenantToken(appId: string, appSecret: string): Promise<string | null> {
  const resp = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const json = await resp.json();
  return json?.tenant_access_token || null;
}

// 发送文本消息到群
async function sendText(tenantToken: string, chatId: string, text: string) {
  const resp = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Authorization": `Bearer ${tenantToken}`,
    },
    body: JSON.stringify({
      receive_id: chatId,
      msg_type: "text",
      content: JSON.stringify({ text }),
    }),
  });
  return resp.json();
}

// 从消息内容里提取指令文本
function extractCommandText(content: string): string {
  try {
    const parsed = JSON.parse(content);
    if (parsed?.text) return parsed.text;
    if (parsed?.title) return parsed.title;
  } catch (e) { /* ignore */ }
  return content || "";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const url = new URL(req.url);
  if (url.pathname === "/verify" && req.method === "GET") {
    return new Response(JSON.stringify({ ok: true, challenge: url.searchParams.get("challenge") || "" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const body = await req.text();
    console.log("收到飞书推送:", body.slice(0, 600));

    let payload;
    try { payload = JSON.parse(body); } catch (e) {
      return new Response(JSON.stringify({ error: "invalid json" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 飞书 URL 验证（challenge / encrypt）
    if (payload?.challenge) {
      return new Response(JSON.stringify({ challenge: payload.challenge }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const event = payload?.event || payload?.body?.event || null;
    if (!event) {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const message = event?.message || {};
    const chatId = message?.chat_id || "";
    const msgType = message?.message_type || "";
    const text = extractCommandText(message?.content || "{}");

    const appId = Deno.env.get("FEISHU_APP_ID");
    const appSecret = Deno.env.get("FEISHU_APP_SECRET");
    if (!appId || !appSecret) {
      return new Response(JSON.stringify({ ok: true, note: "env missing" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const tenantToken = await getTenantToken(appId, appSecret);
    if (!tenantToken) {
      return new Response(JSON.stringify({ ok: true, note: "token failed" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 是否 @ 了 dog-watch（消息文本带 dog-watch 或 app_id 或指令关键词）
    // 只要包含明确的指令词(开始巡逻/朗读/转发)就视为指令，不强制要求 @
    const isAtMe = text.includes("dog-watch") || text.includes(appId) || text.includes("朗读") || text.includes("转发") || text.includes("巡逻") || text.includes("开始工作") || text.includes("开始监听");

    // === 指令 0：开始巡逻 ===
    // 用户 @dog-watch "开始巡逻" → 云电脑开始轮询执行朗读/转发指令
    const patrolMatch = text.match(/开始巡逻|巡逻|开始监听|开始工作/);
    if (patrolMatch && isAtMe) {
      console.log("巡逻指令，来自群:", chatId);
      await sendText(tenantToken, chatId, `🛡️ 收到「开始巡逻」指令，已通知云电脑启动监听。\n（云电脑最多10分钟内开始轮询执行指令）`);
      await sendText(tenantToken, RELAY_CHAT_ID, `[巡逻] on`);
      console.log("已转发巡逻启动指令到喇叭群中转");
      return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // === 指令 1：朗读 <链接> ===
    const readMatch = text.match(/朗读\s*(https?:\/\/\S+)/);
    if (readMatch && isAtMe) {
      const docUrl = readMatch[1];
      console.log("朗读指令，链接:", docUrl, "来自群:", chatId);
      await sendText(tenantToken, chatId, `📖 收到朗读指令，正在处理：${docUrl}\n（语音将由云电脑生成，稍后发到本群，请稍候…）`);
      await sendText(tenantToken, RELAY_CHAT_ID, `[朗读] 来源群=${chatId} 链接=${docUrl}`);
      console.log("已转发朗读指令到喇叭群中转");
      return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // === 指令 1.5：111 扫描喇叭群新文档并逐个朗读 ===
    // 用户 @dog-watch "111" → 云电脑扫描喇叭群里 24h 内新文档/链接，逐个转语音发回喇叭群
    const isReadRecent = text.trim() === "111" || text.includes("111") && (text.replace(/[^0-9]/g, "") === "111");
    if (isReadRecent) {
      console.log("111 朗读最近文档指令，来自群:", chatId);
      await sendText(tenantToken, chatId, `📖 收到「111」指令，将扫描喇叭群里最近的新文档/链接，逐个转语音发回本群。\n（语音稍后发出，请稍候…）`);
      await sendText(tenantToken, RELAY_CHAT_ID, `[朗读最近] 来源群=${chatId}`);
      console.log("已转发朗读最近指令到喇叭群中转");
      return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // === 指令 1b：朗读最近文档（口语指令，无具体链接）===
    // "朗读文档/朗读以上内容/朗读链接/朗读链/朗读这个" 等 → 云电脑取喇叭群里最近一条文档朗读
    const readRecentMatch = text.match(/朗读\s*(文档|以上内容|以上|链接|链|这个|内容|上面|下面)/);
    const hasUrl = text.match(/https?:\/\/\S+/);
    if (readRecentMatch && isAtMe && !hasUrl) {
      console.log("朗读最近文档指令，来自群:", chatId);
      await sendText(tenantToken, chatId, `📖 收到朗读指令，将朗读喇叭群里最近的一条文档。\n（语音稍后发到本群，请稍候…）`);
      await sendText(tenantToken, RELAY_CHAT_ID, `[朗读最近] 来源群=${chatId}`);
      console.log("已转发朗读最近文档指令到喇叭群中转");
      return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // === 指令 0.5：222 清理文字消息 ===
    // 用户 @dog-watch "222" → 通知云电脑删除喇叭群里所有文字消息(含测试对话)，只保留文档和语音
    const isCleanup222 = text.trim() === "222" || text.includes("222") && (text.replace(/[^0-9]/g, "") === "222");
    if (isCleanup222) {
      console.log("222 清理文字指令，来自群:", chatId);
      await sendText(tenantToken, chatId, `🗑️ 收到「222」指令，将清理喇叭群里所有文字消息（含测试对话），只保留文档和语音。\n（正在执行…）`);
      await sendText(tenantToken, RELAY_CHAT_ID, `[清理文字] 来源群=${chatId}`);
      console.log("已转发清理文字指令到喇叭群中转");
      return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // === 指令 2：转发 <内容> 到 <群> ===
    // 支持 "转发 <链接/文件名> 到 <群名>" 或 "搬运 <链接> 到 <群名>"
    const forwardMatch = text.match(/(转发|搬运)\s*(.+?)\s*(?:到|→)\s*([^\s]+)/);
    if (forwardMatch && isAtMe) {
      const what = forwardMatch[2].trim();
      const target = forwardMatch[3].trim();
      console.log("转发指令:", what, "→", target, "来自群:", chatId);
      await sendText(tenantToken, chatId, `📦 收到转发指令：${what} → ${target}\n（正在搬运，稍候…）`);
      await sendText(tenantToken, RELAY_CHAT_ID, `[转发] 来源群=${chatId} 内容=${what} 目标群=${target}`);
      console.log("已转发搬运指令到喇叭群中转");
      return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // === 默认：回"收到"（不执行额外动作） ===
    const replyText = `收到，dog-watch 已上线 ✅\n聊天ID: ${chatId}\n消息ID: ${message?.message_id || ""}\n类型: ${msgType}\n你说了: ${text || "(非文本消息)"}`;
    await sendText(tenantToken, chatId, replyText);
    console.log("回复结果 默认收到");

    return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err) {
    console.error("处理异常:", err);
    return new Response(JSON.stringify({ ok: true, error: String(err) }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
