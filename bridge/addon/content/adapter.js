(function (root) {
  "use strict";

  function attach(view, host) {
    const required = ["ask", "execText", "execTag", "createActiveOutputBox", "recordConversation", "getAllCiteProps"];
    if (!required.every(name => typeof view?.[name] === "function")) throw new Error("Awesome GPT 的聊天接口不兼容，请更新连接插件。");
    const originals = new Map();
    const wrappers = new Map();
    const requests = [];
    const nodes = new WeakMap();
    const docs = new WeakMap();
    const tagKey = tag => { try { return JSON.stringify(tag); } catch { return ""; } };
    const currentPaper = () => { try { return host.currentPaper(); } catch (error) { host.log(error); return null; } };
    let syncRequest = null;
    let active = true;

    function wrap(name, factory) {
      const original = view[name];
      const wrapped = factory(original);
      originals.set(name, original);
      wrappers.set(name, wrapped);
      view[name] = wrapped;
    }

    function invoke(original, receiver, args, request) {
      requests.push(request);
      const previous = syncRequest;
      syncRequest = request;
      let result;
      try { result = original.apply(receiver, args); }
      catch (error) { requests.splice(requests.indexOf(request), 1); throw error; }
      finally { syncRequest = previous; }
      return Promise.resolve(result).finally(() => {
        const index = requests.indexOf(request);
        if (index >= 0) requests.splice(index, 1);
      });
    }

    wrap("execText", original => function (...args) {
      let tag;
      try { tag = this.getTriggerTag?.(args[0]); } catch {}
      return invoke(original, this, args, { kind: "text", paper: currentPaper(), tag: tagKey(tag), used: false });
    });

    wrap("execTag", original => function (...args) {
      const key = tagKey(args[0]);
      const parent = syncRequest || requests.find(request => request.kind === "text" && request.tag === key);
      return invoke(original, this, args, { kind: "tag", paper: parent ? parent.paper : currentPaper(), tag: key, used: false });
    });

    wrap("getAllCiteProps", original => function (...args) {
      const paper = syncRequest ? syncRequest.paper : currentPaper();
      return Promise.resolve(original.apply(this, args)).then(result => {
        if (result?.docs && typeof result.docs === "object") docs.set(result.docs, paper);
        return result;
      });
    });

    wrap("ask", original => function (...args) {
      if (args[3]?.isolated) return original.apply(this, args);
      const cited = args[1];
      const paper = cited && docs.has(cited) ? docs.get(cited) : (syncRequest ? syncRequest.paper : currentPaper());
      return invoke(original, this, args, { kind: "ask", input: args[0], paper, used: false });
    });

    wrap("createActiveOutputBox", original => function (...args) {
      const node = original.apply(this, args);
      const request = args[1]
        ? requests.find(entry => !entry.used && entry.kind === "tag" && entry.tag === tagKey(args[1]))
        : requests.find(entry => !entry.used && entry.kind === "ask" && entry.input === args[0]);
      if (node && request) { request.used = true; nodes.set(node, request.paper); }
      return node;
    });

    wrap("recordConversation", original => function (...args) {
      return Promise.resolve(original.apply(this, args)).then(result => {
        const node = args[0];
        if (!active || node?.dataset?.isolatedRequest === "true" || !node?.isConnected) return result;
        const id = node.dataset.overlayHistoryId;
        const row = this.conversationHistory?.find(record => record.id === id);
        const answer = row?.outputText || node.getAttribute("outputText") || args[1] || "";
        // A retry first clears the existing output. Keep the archived answer until its replacement completes.
        if (!id || !String(answer).trim()) return result;
        const record = row || { id, inputText: node.getAttribute("inputText") || "", outputText: answer, createdAt: Date.now() };
        try {
          Promise.resolve(host.capture(record, nodes.has(node) ? nodes.get(node) : null)).catch(error => host.log(error));
        } catch (error) { host.log(error); }
        return result;
      });
    });

    return {
      detach() {
        active = false;
        for (const [name, original] of originals) if (view[name] === wrappers.get(name)) view[name] = original;
      }
    };
  }

  const api = { attach };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ZOBAdapter = api;
})(globalThis);
