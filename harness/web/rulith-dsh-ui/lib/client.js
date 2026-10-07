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
            // An Agent chosen earlier but not set up on this computer (for example after signing in again) cannot be
            // set up by its radio, which is already checked: the row offers the step itself.
            a.paired ? dot(a.worker && a.worker.state === "online" ? GREEN : AMBER)
              : h("button", { style: { ...button, fontSize: 11 }, disabled: !!busy,
                  onClick: (event) => { event.preventDefault(); run("select", () => api("select", { agentId: a.id })); } }, "在本机设置"))),
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
    const LEVEL = { ok: GREEN, info: GREY, warn: AMBER, error: "#f85149" };
    const small = { fontSize: 11, opacity: 0.65 };
    const timeOf = (value) => { const at = new Date(value); return Number.isNaN(at.getTime()) ? "" : at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); };
    const block = (title, extra, body) => h("div", { style: { marginBottom: 14 } },
      h("div", { style: { ...section, display: "flex", justifyContent: "space-between" } }, h("span", null, title), extra ? h("span", { style: { textTransform: "none" } }, extra) : null), body);
    const none = (text) => h("div", { style: { opacity: 0.6, fontSize: 12 } }, text);
    const OPERATION_WORDS = { running: "进行中", done: "已确认", failed: "失败", refused: "被拒绝", unknown: "结果未知" };
    // "ApplyAction worker_<connection>_eng_read_1" reads as "eng.read"; built-in Source tools lose their id suffix.
    const shortLabel = (label) => String(label || "").replace(/^ApplyAction\s+/, "").replace(/^worker_[a-z0-9]+_/, "").replace(/_\d+$/, "")
      .replace(/_[0-9a-f]{12}$/, "").replace(/^eng_/, "eng.");
    const STAGE_WORDS = { at_worker: "在本机执行", held: "等待决定", dispatched: "已派发" };

    // The right column is this environment's execution, as the Rulith Runtime shows it beside a conversation:
    // Cases, recent operations, the current frontier, and the local Worker's activity.
    function RulithColumn() {
      const [data, refresh] = usePoll("board", 6000);
      const [worker, refreshWorker] = usePoll("worker", 6000);
      const [trace, setTrace] = useState(true);
      const reload = () => { refresh(); refreshWorker(); };
      if (!data) return h("div", { style: { padding: 12 } }, "正在读取 Rulith…");
      if (!data.ok) return h("div", { style: { padding: 12, color: AMBER } }, data.teaching || "读不到 Rulith");
      if (!data.available) return h("div", { style: { padding: 12 } }, "还没有接入 Rulith：请在左下角登录并选择 Agent。");
      const view = data.view || {};
      const board = view.view || view;
      const cases = Array.isArray(board.cases) ? board.cases : (board.cases && board.cases.directory) || [];
      const ops = view.operations || board.operations || [];
      const goals = Array.isArray(board.goals) ? board.goals : [];
      const frontier = Array.isArray(board.frontier) ? board.frontier : Array.isArray(board.gaps) ? board.gaps : [];
      const actions = Array.isArray(board.actions) ? board.actions : [];
      const ready = actions.filter((a) => a.status === "ready").length;
      const w = worker && worker.ok && worker.available ? worker : null;
      const online = w && w.state === "online";

      const caseRows = cases.length ? cases.slice(0, 12).map((c, i) => h("div", { key: i, style: { padding: "3px 0", fontSize: 12 } },
          h("div", null, show(c.caseId || c.case || c.id || c) + (c.label ? " — " + show(c.label) : "")),
          h("div", { style: small }, [c.caseType, c.status || c.state, c.root ? "root " + show(c.root) : ""].filter(Boolean).map(show).join(" · "))))
        : none("还没有 Case：开始一项任务后，这里显示它的 Case。");
      const opRows = ops.length ? ops.slice(0, 12).map((o, i) => h("div", { key: i, style: { padding: "3px 0", fontSize: 12 } },
          h("div", { style: { display: "flex", gap: 6, alignItems: "center" } }, dot(o.state === "done" ? GREEN : o.state === "running" ? AMBER : o.state ? "#f85149" : GREY),
            h("span", { style: { overflow: "hidden", textOverflow: "ellipsis" } }, shortLabel(o.label || o.tool))),
          h("div", { style: small }, [OPERATION_WORDS[o.state] || o.state, STAGE_WORDS[o.stage] || o.stage, o.since ? "自 " + timeOf(o.since) : "", o.summary].filter(Boolean).map(show).join(" · "))))
        : none("还没有操作。");
      const frontierRows = goals.length || frontier.length ? h("div", null,
          goals.slice(0, 12).map((g, i) => h("div", { key: "g" + i, style: { padding: "2px 0", fontSize: 12 } }, (g.met || g.satisfied ? "✓ " : "○ ") + show(g.label || g.goal || g.nodeId || g))),
          frontier.slice(0, 12).map((f, i) => h("div", { key: "f" + i, style: { padding: "2px 0", fontSize: 12 } }, show(f.label || f.predicate || f.gap || f) + (f.action ? " · " + show(f.action) : ""))))
        : none("没有进行中的目标。");

      let workerBody;
      if (!worker) workerBody = none("正在读取本机执行…");
      else if (!worker.ok) workerBody = h("div", { style: { color: AMBER, fontSize: 12 } }, "读不到本机执行：" + (worker.teaching || ""));
      else if (!worker.available) workerBody = none("还没有选择 Agent。");
      else workerBody = h("div", null,
        h("div", { style: { display: "flex", alignItems: "center", gap: 8, fontSize: 12 } }, dot(online ? GREEN : AMBER),
          h("span", { style: { flex: 1 } }, online ? "在线" : "不在线（" + w.state + "）"),
          h("span", { style: small }, ready + " 个动作就绪")),
        (w.sources || []).map((src, i) => h("div", { key: i, style: { fontSize: 12, marginTop: 4 } },
          h("span", { style: { fontWeight: 600 } }, src.name), h("span", { style: small }, " " + src.type + " → "), h("span", null, src.location || "未绑定位置"))),
        w.stuck ? h("div", { role: "alert", style: { marginTop: 6, color: LEVEL.error, fontSize: 12 } },
          "有调用的结果没有送达，它会一直挂起：在 Console 里处理这次调用，或停止当前回复。") : null,
        h("div", { style: { marginTop: 8, display: "flex", justifyContent: "space-between", alignItems: "center" } },
          h("span", { style: small }, "最近的执行"),
          h("button", { style: { ...button, padding: "1px 8px", fontSize: 11 }, onClick: () => setTrace(!trace) }, trace ? "收起" : "展开")),
        trace ? h("div", { style: { marginTop: 4 } }, (w.events || []).length ? w.events.map((e, i) =>
          h("div", { key: i, style: { display: "flex", gap: 6, alignItems: "baseline", padding: "1px 0", fontSize: 12 } },
            h("span", { style: { opacity: 0.5, flex: "none", fontVariantNumeric: "tabular-nums" } }, e.at ? new Date(e.at).toLocaleTimeString() : ""),
            h("span", { style: { color: LEVEL[e.level] || "inherit", wordBreak: "break-word" } }, e.text))) : none("还没有执行记录。")) : null);

      return h("div", { style: { padding: 12, fontSize: 13, overflow: "auto", height: "100%", boxSizing: "border-box" } },
        h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 } },
          h("b", null, "Rulith · " + (data.agentName || "")), h("button", { style: button, onClick: reload }, "刷新")),
        block("Case", cases.length ? String(board.cases && board.cases.total || cases.length) + " 个" : "", caseRows),
        block("最近操作", "", opRows),
        block("当前前沿", "", frontierRows),
        block("本机执行（Worker）", "", workerBody));
    }

    const RulithArtwork = () => h("span", { style: { display: "inline-flex", alignItems: "center", justifyContent: "center", width: 28, height: 28,
      borderRadius: 7, background: "#2ea36b", color: "#fff", fontWeight: 800, fontSize: 16 } }, "R");
    function apply(ctx) {
      // Deep Rulith keeps the Rulith Runtime's three columns: sessions, the conversation, and on the right the execution
      // in this environment. The Rulith column is the right sidebar's entry, and every session opens with it.
      ctx.effect(() => ctx.sidebarRightTabs.register({ id: TAB_ID, kind: TAB_KIND, priority: "builtin", title: () => "Rulith",
        guide: [{ id: "rulith", commandId: "rulith.panel", order: 1, title: () => "Rulith",
          description: () => "Case、最近操作、当前前沿和本机执行", icon: RulithArtwork }] }));
      let revealed = false;
      const ensureColumn = () => setTimeout(() => {
        try {
          const session = ctx.sidebarRight.mounted.getSnapshot();
          if (session === undefined) return;
          if (!ctx.sidebarRight.tabsIn(session).some((tab) => tab.kind === TAB_KIND)) ctx.sidebarRight.openTabIn(session, TAB_KIND, {});
          // Shown once per page load; a person who collapses it keeps it collapsed.
          if (!revealed) { revealed = true; if (!ctx.sidebarRight.isExpanded()) ctx.sidebarRight.toggleExpanded(); }
        } catch (error) { console.warn("Deep Rulith: could not open the Rulith column", error); }
      }, 0);
      ctx.effect(() => ctx.sidebarRight.mounted.subscribe(ensureColumn));
      ensureColumn();
      ctx.inject(["shortcuts"], (inner) => {
        inner.effect(() => inner.shortcuts.register({ id: "rulith.panel", label: () => "Rulith", aliases: ["rulith", "board", "worker"],
          defaults: {}, regions: ["page", "editable", "terminal"], modals: [],
          resolve: ({ target: element }) => {
            const target = ctx.sidebarRight.commandTarget(element);
            if (target === void 0) return { status: "blocked", reason: "先打开一个会话" };
            return { status: "handled", run: () => ctx.sidebarRight.openTabFromTarget(TAB_KIND, target) };
          } }));
      });
      const openBoard = () => { try { ctx.sidebarRight.openTab(TAB_KIND, {}); } catch (error) { console.warn("Deep Rulith: could not open the Rulith tab", error); } };
      ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({ name: "sidebar.footer.action", id: "rulith-account", inject: () => ({ openBoard }) }, RulithAccount));
      ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({ name: "sidebar.right.pane.tab", key: TAB_ID, inject: () => ({}) }, RulithColumn));
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
