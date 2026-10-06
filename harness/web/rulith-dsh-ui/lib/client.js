// Deep Rulith, browser half (plain script for dsh's module loader: no build step). The account entry at the sidebar foot
// and the Rulith tab in the right sidebar read and act only through /rulith/api on dsh's own server, which forwards to the
// owner's Rulith Runtime manager and to Rulith's MCP authority. No token, key or secret is part of this script.
window.__ModuleLoader__.load({
  id: "rulith-dsh-ui",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require("react");
    const h = React.createElement;
    const { useState, useEffect, useCallback } = React;
    const TAB_ID = "rulith-dsh-ui/board";
    const TAB_KIND = "rulithBoard";
    const GREEN = "#3fb950", AMBER = "#d29922", GREY = "#8b949e";

    async function api(path, body) {
      const response = await fetch("/rulith/api/" + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { "x-deep-rulith": "1", "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: "same-origin",
      });
      return response.json();
    }
    // The Runtime workbench, for settings Deep Rulith does not show (the model). Its address carries the manager key, so
    // it is fetched on demand through the guarded API and never stored in this page.
    async function openWorkbench() {
      const win = window.open("about:blank", "_blank");
      try {
        const reply = await api("workbench", {});
        if (win && reply.ok && reply.url) { win.opener = null; win.location.replace(reply.url); } else if (win) win.close();
      } catch { if (win) win.close(); }
    }
    function usePoll(path, ms) {
      const [data, setData] = useState(null);
      const refresh = useCallback(async () => {
        try { setData(await api(path)); } catch (error) { setData({ ok: false, teaching: String(error) }); }
      }, [path]);
      useEffect(() => { refresh(); const timer = setInterval(refresh, ms); return () => clearInterval(timer); }, [refresh, ms]);
      return [data, refresh, setData];
    }
    const dot = (color) => h("span", { style: { display: "inline-block", width: 8, height: 8, borderRadius: 4, background: color, flex: "none" } });
    const selectedAgent = (s) => (s && s.agents || []).find((a) => a.name === s.selected);
    function health(s) {
      if (!s || !s.ok || !s.signedIn) return { color: GREY, text: s && s.ok === false ? "Rulith 未连接" : "未登录 Rulith" };
      const agent = selectedAgent(s);
      if (!agent) return { color: AMBER, text: "请选择 Agent" };
      const tools = s.tools && s.tools.state === "attached";
      const worker = agent.worker && agent.worker.state === "online";
      return { color: tools && worker ? GREEN : AMBER, text: agent.name + (worker ? " · 本机执行在线" : " · 本机执行未在线") };
    }
    const button = { padding: "4px 10px", borderRadius: 6, border: "1px solid rgba(127,127,127,.4)", background: "transparent", color: "inherit", cursor: "pointer", font: "inherit", fontSize: 12 };
    const section = { fontSize: 11, opacity: 0.6, margin: "10px 0 4px", textTransform: "uppercase", letterSpacing: ".04em" };

    function AccountPanel({ state, setState, refresh, openBoard }) {
      const [busy, setBusy] = useState("");
      const [notice, setNotice] = useState("");
      const run = async (label, action) => {
        setBusy(label); setNotice("");
        try { const reply = await action(); if (reply && reply.ok === false) setNotice(reply.teaching || "操作没有完成"); else if (reply && reply.ok) setState(reply); }
        catch (error) { setNotice(String(error)); } finally { setBusy(""); }
      };
      const signIn = () => run("signin", async () => {
        let tab = null; try { tab = window.open("about:blank", "_blank"); } catch (e) { tab = null; }
        const reply = await api("signin", {});
        if (!reply.ok || !reply.url) { if (tab) tab.close(); return reply; }
        if (tab) tab.location.href = reply.url; else window.open(reply.url, "_blank", "noopener");
        for (let i = 0; i < 60; i++) {
          await new Promise((resolve) => setTimeout(resolve, 3000));
          const polled = await api("signin/poll", {});
          if (polled.ok && polled.signedIn) return polled;
        }
        return { ok: false, teaching: "登录还没有完成：请在打开的 Rulith 页面里批准，再点一次登录。" };
      });
      const s = state || {};
      const agent = selectedAgent(s);
      return h("div", { style: { position: "fixed", left: 8, bottom: 56, width: 320, maxHeight: "70vh", overflow: "auto", zIndex: 1000,
          padding: 12, borderRadius: 10, border: "1px solid rgba(127,127,127,.35)", background: "var(--color-bg-elevated, #1f2328)", boxShadow: "0 8px 24px rgba(0,0,0,.35)", fontSize: 13 } },
        h("div", { style: { fontWeight: 700, marginBottom: 6 } }, "Deep Rulith"),
        h("div", { style: section }, "Rulith 账户"),
        s.signedIn
          ? h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center" } },
              h("span", null, s.account), h("button", { style: button, disabled: !!busy, onClick: () => run("signout", () => api("signout", {})) }, "退出登录"))
          : h("button", { style: button, disabled: !!busy, onClick: signIn }, busy === "signin" ? "等待浏览器里批准…" : "登录 Rulith"),
        s.signedIn ? h("div", null,
          h("div", { style: section }, "Agent"),
          (s.agents || []).map((a) => h("label", { key: a.id, style: { display: "flex", alignItems: "center", gap: 8, padding: "3px 0", cursor: "pointer" } },
            h("input", { type: "radio", name: "deep-rulith-agent", checked: a.name === s.selected, disabled: !!busy,
              onChange: () => run("select", () => api("select", { agentId: a.id })) }),
            h("span", { style: { flex: 1 } }, a.name),
            a.paired ? dot(a.worker && a.worker.state === "online" ? GREEN : AMBER) : h("span", { style: { fontSize: 11, opacity: 0.6 } }, "未在本机设置"))),
          agent && agent.instanceId ? h("label", { style: { display: "flex", alignItems: "center", gap: 8, marginTop: 8 } },
            h("input", { type: "checkbox", checked: !!(agent.worker && agent.worker.enabled), disabled: !!busy,
              onChange: (event) => run("worker", () => api("worker", { instanceId: agent.instanceId, enabled: event.target.checked })) }),
            "使用这台电脑的工具和文件（本机 Worker）") : null,
          h("div", { style: section }, "模型"),
          h("div", null, s.model && s.model.configured ? s.model.name + " · " + s.model.url.replace(/^https?:\/\//, "").replace(/\/$/, "") : "未设置"),
          h("div", { style: { fontSize: 11, opacity: 0.6 } }, "模型在 Rulith 设置里配置，改动后重启 Deep Rulith 生效。"),
          h("div", { style: section }, "Rulith 工具"),
          h("div", null, s.tools && s.tools.state === "attached" ? "已接入（六个）" : s.tools && s.tools.state === "failed" ? "接入失败：" + (s.tools.error || "") : "未接入"),
        ) : null,
        notice ? h("div", { role: "alert", style: { marginTop: 8, color: AMBER } }, notice) : null,
        h("div", { style: { display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" } },
          h("button", { style: button, onClick: openBoard }, "打开 Rulith 面板（在对话里）"),
          h("button", { style: button, onClick: refresh }, "刷新"),
          h("button", { style: button, onClick: openWorkbench }, "更多设置")));
    }

    function RulithAccount({ wide, openBoard }) {
      const [state, refresh, setState] = usePoll("state", 5000);
      const [open, setOpen] = useState(false);
      const status = health(state);
      return h("div", { style: { position: "relative", width: "100%" } },
        h("button", { type: "button", title: "Deep Rulith：" + status.text, onClick: () => setOpen(!open),
            style: { display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "6px 8px", border: "1px solid rgba(127,127,127,.35)",
              borderRadius: 8, background: "transparent", color: "inherit", cursor: "pointer", font: "inherit", fontSize: 13, textAlign: "left" } },
          dot(status.color),
          wide ? h("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
            state && state.signedIn ? state.account + " · " + status.text : status.text) : null),
        open ? h(AccountPanel, { state, setState, refresh, openBoard: () => { openBoard(); setOpen(false); } }) : null);
    }

    function show(value) {
      if (value === undefined || value === null) return "";
      return typeof value === "string" ? value : JSON.stringify(value);
    }
    function RulithBoard() {
      const [data, refresh] = usePoll("board", 6000);
      if (!data) return h("div", { style: { padding: 12 } }, "正在读取 Rulith…");
      if (!data.ok) return h("div", { style: { padding: 12, color: AMBER } }, data.teaching || "读不到 Rulith");
      if (!data.available) return h("div", { style: { padding: 12 } }, "还没有接入 Rulith：请在左下角登录并选择 Agent。");
      const view = data.view || {};
      const board = view.view || view;
      const cases = Array.isArray(board.cases) ? board.cases : (board.cases && board.cases.directory) || [];
      const ops = view.operations || board.operations || [];
      const actions = board.actions || [];
      const goals = board.goals || [];
      const task = board.taskStatus || null;
      const position = board.position || null;
      const block = (title, body) => h("div", { style: { marginBottom: 12 } }, h("div", { style: section }, title), body);
      const rows = (items, render) => items.length ? h("div", null, items.slice(0, 20).map(render)) : h("div", { style: { opacity: 0.6 } }, "无");
      return h("div", { style: { padding: 12, fontSize: 13, overflow: "auto", height: "100%" } },
        h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 } },
          h("b", null, "Rulith · " + (data.agentName || "")), h("button", { style: button, onClick: refresh }, "刷新")),
        position ? block("当前位置", h("div", { style: { fontSize: 12 } }, "写入 " + show(position.writes) + " · 新 Case " + show(position.newCases) + " · 规则 " + show(position.rules))) : null,
        task ? block("任务状态", h("div", { style: { whiteSpace: "pre-wrap", fontSize: 12 } }, show(task))) : null,
        block("Case", rows(cases, (c, i) => h("div", { key: i, style: { padding: "2px 0" } }, show(c.caseId || c.case || c.id || c) + (c.status ? " · " + c.status : "")))),
        goals.length ? block("目标", rows(goals, (g, i) => h("div", { key: i, style: { padding: "2px 0" } }, (g.met || g.satisfied ? "✓ " : "○ ") + show(g.label || g.goal || g.nodeId || g)))) : null,
        block("最近操作", rows(ops, (o, i) => h("div", { key: i, style: { padding: "2px 0", fontSize: 12 } },
          [o.tool || o.operation || o.kind, o.action, o.status || o.outcome].filter(Boolean).map(show).join(" · ")))),
        block("动作", rows(actions, (a, i) => h("div", { key: i, style: { display: "flex", gap: 6, alignItems: "center", padding: "2px 0", fontSize: 12 } },
          dot(a.status === "ready" ? GREEN : AMBER), h("span", null, show(a.action || a.name)), a.reason ? h("span", { style: { opacity: 0.6 } }, show(a.reason)) : null))));
    }

    function apply(ctx) {
      ctx.effect(() => ctx.sidebarRightTabs.register({ id: TAB_ID, kind: TAB_KIND, priority: "builtin", title: () => "Rulith" }));
      const openBoard = () => { try { ctx.sidebarRight.openTab(TAB_KIND, {}); } catch (error) { console.warn("Deep Rulith: could not open the Rulith tab", error); } };
      ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({ name: "sidebar.footer.action", id: "rulith-account", inject: () => ({ openBoard }) }, RulithAccount));
      ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({ name: "sidebar.right.pane.tab", key: TAB_ID, inject: () => ({}) }, RulithBoard));
      ctx.slots.inject("sidebar.right.pane.tab.title", () => ctx.slots.register({ name: "sidebar.right.pane.tab.title", key: TAB_ID, inject: () => ({}) }, () => h("span", null, "Rulith")));
      ctx.slots.inject("sidebar.brand.mark", () => ctx.slots.inject("sidebar.brand.name", function* () {
        yield ctx.slots.register({ name: "sidebar.brand.mark" }, ({ size }) => h("span", { style: { display: "inline-flex", alignItems: "center", justifyContent: "center",
          width: size || 20, height: size || 20, borderRadius: 6, background: "#2ea36b", color: "#fff", fontWeight: 800, fontSize: Math.round((size || 20) * 0.6) } }, "R"));
        yield ctx.slots.register({ name: "sidebar.brand.name" }, () => h("span", { style: { fontWeight: 700 } }, "Deep Rulith"));
      }));
    }
    exports.apply = apply;
    exports.inject = ["slots", "sidebarRightTabs", "sidebarRight"];
    return module.exports;
  }
});
