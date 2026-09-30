// Supabase Edge Function: dog-watch 飞书机器人
// GitHub Actions 自动部署验证（触发 CI 部署链路）
// 架构（混合）：dog-watch 在 supabase 实时识别指令(零token) → 转发内部指令到喇叭群中转
// → 云电脑 relay 用你的飞书身份执行朗读/清理/搬运。
//
// 指令识别（实时，supabase）：
//  - "111" → 转发 [朗读最近]（云电脑扫描喇叭群新文档逐个朗读）
//  - "222" → 转发 [清理文字]（云电脑删除喇叭群所有文字，保留文档/语音）
//  - "朗读 <链接>" → 转发 [朗读] 到喇叭群中转
//  - "转发 <内容> 到 <群>" → 转发 [转发] 到喇叭群中转
//  - 其他 → 回"收到"（默认）
//
// 执行（云电脑）由你手动说指令 / 定时任务驱动 relay 扫描喇叭群中转消息执行。

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-request-id, x-lark-signature",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// 喇叭群作为中转群（dog-watch 已在该群）
const RELAY_CHAT_ID = "oc_23ae2d7c114f225480d53b5e74ccf37d";
// 记录指令中转群(隐蔽，用户不在)：333/666 的内部指令转发到这里，relay 从这读，不暴露给用户
const RECORD_RELAY_CHAT_ID = "oc_77b17a97abfeed88ff25e6a35758fc0b";

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

// 列出群消息（分页拉全量，最多拉 total 条）
async function listChatMessages(tenantToken: string, chatId: string, maxMsgs = 100): Promise<any[]> {
  let all: any[] = [];
  let pageToken = "";
  for (let i = 0; i < 10; i++) {
    let url = `https://open.feishu.cn/open-apis/im/v1/messages?container_id_type=chat&container_id=${chatId}&page_size=50&sort_type=ByCreateTimeDesc`;
    if (pageToken) url += `&page_token=${encodeURIComponent(pageToken)}`;
    const resp = await fetch(url, {
      headers: { "Authorization": `Bearer ${tenantToken}` },
    });
    const j = await resp.json();
    if (!j?.data?.items) break;
    all = all.concat(j.data.items);
    if (!j.data.has_more || all.length >= maxMsgs) break;
    pageToken = j.data.page_token || "";
  }
  return all;
}

// 删除一条消息（返回是否成功 + 错误码）
async function deleteMessage(tenantToken: string, messageId: string): Promise<{ ok: boolean; code?: number; msg?: string }> {
  const resp = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}`, {
    method: "DELETE",
    headers: { "Authorization": `Bearer ${tenantToken}` },
  });
  const j = await resp.json();
  return { ok: !!j?.code || j?.code === 0, code: j?.code, msg: j?.msg };
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

    // 剥掉 @ 提及（<at ...>..</at> 或裸 @xxx）再 trim，供 111/222/333/666 数字口令判断
    const stripAt = (s: string) => s
      .replace(/<at[^>]*>.*?<\/at>/g, "")
      .replace(/@[^\s@]+/g, "")
      .replace(/@_user_\d+/g, "")
      .trim();
    const trimText = stripAt(text);
    // 数字口令判断：剥 @ 后仅由目标数字构成才算命中（如 111/222/333/666）
    const isNumberCmd = (n: string) => trimText === n || (trimText.includes(n) && trimText.replace(/[^0-9]/g, "") === n);

    // 过滤掉 dog-watch 自己（app 身份）发出的消息，避免自我回显/刷屏
    const senderType = event?.sender?.sender_type || "";
    const isSelfSent = senderType === "app";
    if (isSelfSent) {
      console.log("忽略 dog-watch 自己发送的消息，避免回显循环");
      return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

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
      await sendText(tenantToken, RECORD_RELAY_CHAT_ID, `[巡逻] on`);
      console.log("已转发巡逻启动指令到喇叭群中转");
      return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // === 指令 1：朗读 <链接> ===
    const readMatch = text.match(/朗读\s*(https?:\/\/\S+)/);
    if (readMatch && isAtMe) {
      const docUrl = readMatch[1];
      console.log("朗读指令，链接:", docUrl, "来自群:", chatId);
      await sendText(tenantToken, chatId, `📖 收到朗读指令，正在处理：${docUrl}\n（语音将由云电脑生成，稍后发到本群，请稍候…）`);
      await sendText(tenantToken, RECORD_RELAY_CHAT_ID, `[朗读] 来源群=${chatId} 链接=${docUrl}`);
      console.log("已转发朗读指令到喇叭群中转");
      return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // === 指令 1.5：111 扫描喇叭群新文档并逐个朗读 ===
    // 用户 @dog-watch "111" → 云电脑扫描喇叭群里 24h 内新文档/链接，逐个转语音发回喇叭群
    const isReadRecent = isNumberCmd("111");
    if (isReadRecent) {
      console.log("111 朗读最近文档指令，来自群:", chatId);
      // 不回执（用户要求去掉"收到"提示），仅转发指令到记录中转群由云电脑静默执行朗读
      await sendText(tenantToken, RECORD_RELAY_CHAT_ID, `[朗读最近] 来源群=${chatId}`);
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
      await sendText(tenantToken, RECORD_RELAY_CHAT_ID, `[朗读最近] 来源群=${chatId}`);
      console.log("已转发朗读最近文档指令到喇叭群中转");
      return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // === 指令 0.5：222 清理文字消息（混合架构：supabase识别→转发云电脑执行） ===
    // 用户 @dog-watch "222" → 云电脑用你的用户身份删除"当前群"所有文字消息，保留文档和语音
    const isCleanup222 = isNumberCmd("222");
    if (isCleanup222) {
      console.log("222 清理文字指令，来自群:", chatId);
      await sendText(tenantToken, chatId, `🗑️ 收到「222」指令，将清理本群所有文字消息（含测试对话），只保留文档和语音。\n（正在执行…）`);
      await sendText(tenantToken, RECORD_RELAY_CHAT_ID, `[清理文字] 来源群=${chatId} 目标群=${chatId}`);
      console.log("已转发清理文字指令到云电脑");
      return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // === 指令 1c：333 记录股票池 / 666 记录日常记事 ===
    // 用户 @dog-watch "333 <内容>" → 写入「dog-watch 记事本」股票池表
    // 用户 @dog-watch "666 <内容>" → 写入「dog-watch 记事本」日常记事表
    // 触发方式：消息文本以 333 / 666 开头（trimText 已剥掉 @ 提及）
    let recordContent = "";
    const isRecordStock = /^(?:333|333:)\s*/.test(trimText);
    const isRecordNote = /^(?:666|666:)\s*/.test(trimText);
    if (isRecordStock) {
      // 去掉 333 / 333: 前缀，取之后内容
      let after = trimText.replace(/^333:?\s*/, "");
      // 如果整条消息就是 333（无后续内容），则等待下一条消息作为记录内容
      if (after.trim().length === 0) {
        await sendText(tenantToken, chatId, `📊 收到「333」指令，请输入要记录的股票内容，我会存到「股票池」。`);
        await sendText(tenantToken, RECORD_RELAY_CHAT_ID, `[记录-等待股票] 来源群=${chatId}`);
        console.log("333 记录股票指令（等待内容），来自群:", chatId);
        return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      recordContent = after.trim();
      console.log("333 记录股票指令，内容:", recordContent, "来自群:", chatId);
      await sendText(tenantToken, chatId, `📊 收到「333」记录指令，正在写入「股票池」…`);
      await sendText(tenantToken, RECORD_RELAY_CHAT_ID, `[记录股票] 来源群=${chatId} 内容=${recordContent}`);
      console.log("已转发记录股票指令到用户所在群");
      return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    if (isRecordNote) {
      // 去掉 666 / 666: 前缀，取之后内容
      let after = trimText.replace(/^666:?\s*/, "");
      if (after.trim().length === 0) {
        await sendText(tenantToken, chatId, `📝 收到「666」指令，请输入要记录的日常内容，我会存到「日常记事」。`);
        await sendText(tenantToken, RECORD_RELAY_CHAT_ID, `[记录-等待记事] 来源群=${chatId}`);
        console.log("666 记录记事指令（等待内容），来自群:", chatId);
        return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      recordContent = after.trim();
      console.log("666 记录记事指令，内容:", recordContent, "来自群:", chatId);
      await sendText(tenantToken, chatId, `📝 收到「666」记录指令，正在写入「日常记事」…`);
      await sendText(tenantToken, RECORD_RELAY_CHAT_ID, `[记录记事] 来源群=${chatId} 内容=${recordContent}`);
      console.log("已转发记录记事指令到用户所在群");
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
      await sendText(tenantToken, RECORD_RELAY_CHAT_ID, `[转发] 来源群=${chatId} 内容=${what} 目标群=${target}`);
      console.log("已转发搬运指令到喇叭群中转");
      return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // === 默认：不匹配任何指令，简短确认（去掉冗长的已上线/聊天ID/消息ID/你说了 回显） ===
    const replyText = `收到 ✅`;
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
