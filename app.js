const endpointInput = document.getElementById("endpoint");
const authTokenInput = document.getElementById("auth-token");
const searchInput = document.getElementById("search");
const tagsContainer = document.getElementById("tags");
const tryoutPanel = document.getElementById("tryout-panel");
const panelResizer = document.getElementById("panel-resizer");
const detailContainer = document.getElementById("method-detail");
const clearTagBtn = document.getElementById("clear-tag");
const endpointLabel = document.getElementById("endpoint-label");
const schemaModal = document.getElementById("schema-modal");
const schemaModalTitle = document.getElementById("schema-modal-title");
const schemaModalBody = document.getElementById("schema-modal-body");
const schemaModalClose = document.getElementById("schema-modal-close");
const schemaModalBackdrop = schemaModal?.querySelector("[data-close-schema]");

const DEFAULT_ENDPOINT = "http://localhost:8114";
const SPEC_URL = document.body.dataset.spec;
const SUBSCRIPTION_TOPICS = [
  "new_tip_header",
  "new_tip_block",
  "new_transaction",
  "proposed_transaction",
  "rejected_transaction",
];
let DEFAULT_METHOD = null;

const state = {
  spec: null,
  tags: [],
  methods: [],
  selectedTag: null,
  selectedMethod: null,
  selectedSubscriptionTopic: null,
  searchTerm: "",
  requestId: 1,
  expandedTags: new Set(),
  schemaNames: [],
  schemaRegex: null,
  subscriptionMethod: null,
  endpointMode: "http",
};

function saveSetting(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (_) { }
}

function loadSetting(key) {
  try {
    return localStorage.getItem(key);
  } catch (_) {
    return null;
  }
}

function getAuthHeaders() {
  const token = authTokenInput.value.trim();
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

function applyEndpointMode(mode) {
  state.endpointMode = mode;
  const label = mode === "ws" ? "WebSocket Endpoint" : "HTTP Endpoint";
  if (endpointLabel) endpointLabel.textContent = label;
  endpointInput.placeholder = mode === "ws" ? "wss://..." : "https://...";
  const saved = mode === "ws"
    ? loadSetting("rpcWsEndpoint")
    : loadSetting("rpcEndpoint");
  const value = saved || DEFAULT_ENDPOINT;
  endpointInput.value = value;
}

function saveEndpointValue(value) {
  const key = state.endpointMode === "ws" ? "rpcWsEndpoint" : "rpcEndpoint";
  saveSetting(key, value);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildSchemaLinker() {
  const schemas = state.spec?.components?.schemas || {};
  state.schemaNames = Object.keys(schemas).sort((a, b) => b.length - a.length);
  if (!state.schemaNames.length) {
    state.schemaRegex = null;
    return;
  }
  const pattern = state.schemaNames.map(escapeRegex).join("|");
  state.schemaRegex = new RegExp(`\\b(${pattern})\\b`, "g");
}

function isBlockedNode(node) {
  let current = node.parentElement;
  while (current) {
    const tag = current.tagName;
    if (tag === "A" || tag === "CODE" || tag === "PRE") return true;
    current = current.parentElement;
  }
  return false;
}

function linkifySchemas(root) {
  if (!state.schemaRegex || !root) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let current;
  while ((current = walker.nextNode())) {
    if (!current.nodeValue || !current.nodeValue.trim()) continue;
    if (isBlockedNode(current)) continue;
    nodes.push(current);
  }

  nodes.forEach((node) => {
    const text = node.nodeValue;
    state.schemaRegex.lastIndex = 0;
    let match;
    let lastIndex = 0;
    const frag = document.createDocumentFragment();
    let replaced = false;

    while ((match = state.schemaRegex.exec(text))) {
      const name = match[1];
      const index = match.index;
      if (index > lastIndex) {
        frag.append(document.createTextNode(text.slice(lastIndex, index)));
      }
      const link = document.createElement("a");
      link.href = "#";
      link.dataset.schema = name;
      link.className = "schema-ref";
      link.textContent = name;
      frag.append(link);
      lastIndex = index + name.length;
      replaced = true;
    }

    if (!replaced) return;
    if (lastIndex < text.length) {
      frag.append(document.createTextNode(text.slice(lastIndex)));
    }
    node.parentNode.replaceChild(frag, node);
  });
}

const md = window.markdownit
  ? window.markdownit({
    html: false,
    linkify: true,
    typographer: true,
    breaks: true,
    highlight(code, lang) {
      if (window.hljs && lang && window.hljs.getLanguage(lang)) {
        try {
          return window.hljs.highlight(code, { language: lang }).value;
        } catch (_) { }
      }
      if (window.hljs) {
        try {
          return window.hljs.highlightAuto(code).value;
        } catch (_) { }
      }
      return "";
    },
  })
  : null;

function clear(node) {
  node.innerHTML = "";
}

function unescapePointer(fragment) {
  return fragment.replace(/~1/g, "/").replace(/~0/g, "~");
}

function resolveRef(ref) {
  if (!state.spec || !ref || !ref.startsWith("#/")) return null;
  const path = ref.slice(2).split("/").map(unescapePointer);
  let current = state.spec;
  for (const part of path) {
    if (!current || typeof current !== "object" || !(part in current)) return null;
    current = current[part];
  }
  return current;
}

function schemaTypeLabel(schema) {
  if (!schema) return "";
  if (schema.$ref) return refName(schema.$ref);
  if (schema.type) {
    return Array.isArray(schema.type) ? schema.type.join(" | ") : schema.type;
  }
  if (schema.oneOf) return schema.oneOf.map(schemaTypeLabel).join(" | ");
  if (schema.anyOf) return schema.anyOf.map(schemaTypeLabel).join(" | ");
  if (schema.allOf) return "allOf";
  return "schema";
}

function refName(ref) {
  const parts = ref.split("/");
  return parts[parts.length - 1];
}

function schemaExample(schema, depth = 0, seen = new Set()) {
  if (!schema || depth > 3) return null;
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (schema.enum && schema.enum.length) return schema.enum[0];
  if (schema.$ref) {
    if (seen.has(schema.$ref)) return null;
    seen.add(schema.$ref);
    const resolved = resolveRef(schema.$ref);
    return schemaExample(resolved, depth + 1, seen);
  }
  if (schema.oneOf && schema.oneOf.length) return schemaExample(schema.oneOf[0], depth + 1, seen);
  if (schema.anyOf && schema.anyOf.length) return schemaExample(schema.anyOf[0], depth + 1, seen);
  if (schema.type === "object") return {};
  if (schema.type === "array") return [];
  if (schema.type === "string") return "";
  if (schema.type === "integer" || schema.type === "number") return 0;
  if (schema.type === "boolean") return false;
  return null;
}

function extractExampleParamsFromDescription(method) {
  const desc = method.description || "";
  if (!desc) return null;
  const blocks = Array.from(desc.matchAll(/```json\s*([\s\S]*?)```/gi));
  for (const match of blocks) {
    const raw = match[1]?.trim();
    if (!raw) continue;
    try {
      const json = JSON.parse(raw);
      if (json && json.method === method.name && Array.isArray(json.params)) {
        return json.params;
      }
    } catch (_) {
      // Ignore malformed example blocks.
    }
  }
  return null;
}

function buildTags(spec) {
  const tagMap = new Map();
  const definedTags = Array.isArray(spec.tags) ? spec.tags : [];

  for (const tag of definedTags) {
    tagMap.set(tag.name, { name: tag.name, description: tag.description || "", methods: [] });
  }

  for (const method of spec.methods || []) {
    const methodTags = method.tags && method.tags.length ? method.tags : [{ name: "Untagged" }];
    for (const tag of methodTags) {
      if (!tagMap.has(tag.name)) {
        tagMap.set(tag.name, { name: tag.name, description: tag.description || "", methods: [] });
      }
      tagMap.get(tag.name).methods.push(method);
    }
  }

  return Array.from(tagMap.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function indexMethods(methods) {
  return methods.map((method) => {
    const tagNames = (method.tags || []).map((t) => t.name).join(" ");
    const paramNames = (method.params || []).map((p) => p.name).join(" ");
    const text = `${method.name} ${method.description || ""} ${tagNames} ${paramNames}`.toLowerCase();
    return { ...method, _search: text };
  });
}

function renderTags() {
  clear(tagsContainer);

  const filteredMethods = state.methods.filter(matchesSearch);
  const byTag = new Map();
  filteredMethods.forEach((method) => {
    const tagNames = (method.tags || []).map((t) => t.name);
    if (!tagNames.length) tagNames.push("Untagged");
    tagNames.forEach((name) => {
      if (!byTag.has(name)) byTag.set(name, []);
      byTag.get(name).push(method);
    });
  });

  state.tags.forEach((tag) => {
    const isSubscriptionTag = tag.name === "Subscription";
    const methods = byTag.get(tag.name) || [];
    const topics = isSubscriptionTag
      ? SUBSCRIPTION_TOPICS.filter((topic) => subscriptionTopicMatches(topic))
      : [];

    if (isSubscriptionTag && !topics.length && state.searchTerm) return;
    if (!isSubscriptionTag && !methods.length && state.searchTerm) return;

    const group = el("div", "tag-group");
    if (state.selectedTag === tag.name) group.classList.add("active");

    const header = el("div", "tag-header");
    const title = el("div", "tag-title", tag.name);
    const countLabel = isSubscriptionTag ? `${topics.length} topics` : `${methods.length} methods`;
    const sub = el("div", "tag-sub", countLabel);
    header.append(title, sub);
    header.addEventListener("click", () => {
      state.selectedTag = tag.name;
      if (state.expandedTags.has(tag.name)) {
        state.expandedTags.delete(tag.name);
      } else {
        state.expandedTags.add(tag.name);
      }
      renderTags();
    });

    const list = el("div", "tag-methods");
    if (!state.searchTerm && !state.expandedTags.has(tag.name)) {
      list.style.display = "none";
    }
    if (isSubscriptionTag) {
      topics.forEach((topic) => {
        const link = el("div", "method-link");
        const name = el("div", "method-link-name", topic);
        link.append(name);
        if (state.selectedSubscriptionTopic === topic) {
          link.classList.add("active");
        }
        link.addEventListener("click", () => selectSubscriptionTopic(topic));
        list.append(link);
      });
    } else {
      methods.forEach((method) => {
        const link = el("div", "method-link");
        const name = el("div", "method-link-name", method.name);
        link.append(name);
        if (state.selectedMethod && state.selectedMethod.name === method.name) {
          link.classList.add("active");
        }
        link.addEventListener("click", () => selectMethod(method));
        list.append(link);
      });
    }

    group.append(header, list);
    tagsContainer.append(group);
  });

  if (!filteredMethods.length) {
    tagsContainer.append(el("div", "notice", "No methods match this filter."));
  }
}

function matchesSearch(method) {
  if (state.searchTerm && !method._search.includes(state.searchTerm)) return false;
  return true;
}

function subscriptionTopicMatches(topic) {
  if (!state.searchTerm) return true;
  const term = state.searchTerm;
  if (term.includes("subscr")) return true;
  return topic.toLowerCase().includes(term);
}

function selectMethod(method) {
  state.selectedMethod = method;
  state.selectedSubscriptionTopic = null;
  applyEndpointMode("http");
  renderTags();
  renderDetail(method);
  renderTryPanel();
  const hash = `method=${encodeURIComponent(method.name)}`;
  history.replaceState(null, "", `#${hash}`);
}

function selectSubscriptionTopic(topic) {
  state.selectedMethod = null;
  state.selectedSubscriptionTopic = topic;
  state.selectedTag = "Subscription";
  applyEndpointMode("ws");
  renderTags();
  renderDetail(state.subscriptionMethod || { name: "subscribe", tags: [{ name: "Subscription" }], result: {} }, topic);
  renderTryPanel();
  const hash = `topic=${encodeURIComponent(topic)}`;
  history.replaceState(null, "", `#${hash}`);
}

function renderDetail(method, topicOverride) {
  clear(detailContainer);

  const header = el("div", "method-header");
  const titleText = topicOverride ? `Subscription: ${topicOverride}` : method.name;
  const title = el("h1", "", titleText);
  let desc;
  if (md) {
    desc = el("div", "markdown");
    desc.innerHTML = md.render(method.description || "No description provided.");
    linkifySchemas(desc);
  } else {
    desc = el("pre", "notice", method.description || "No description provided.");
    desc.style.whiteSpace = "pre-wrap";
  }

  const badges = el("div", "badges");
  (method.tags || []).forEach((tag) => {
    badges.append(el("span", "badge", tag.name));
  });
  if (topicOverride) {
    badges.append(el("span", "badge", topicOverride));
  }

  header.append(title, desc, badges);

  const paramsSection = el("div", "section");
  paramsSection.append(el("h3", "", "Parameters"));

  const paramGrid = el("div", "param-grid");
  if (method.params && method.params.length) {
    method.params.forEach((param) => {
      const row = el("div", "param-row");
      const name = el("div", "param-name", param.name);
      const schemaWrap = el("div", "schema-tree");
      const schemaNode = renderSchemaTree(param.schema, param.name, false, new Set());
      schemaWrap.append(schemaNode);
      row.append(name, schemaWrap);
      paramGrid.append(row);
    });
  } else {
    paramGrid.append(el("div", "notice", "No parameters."));
  }
  paramsSection.append(paramGrid);

  const resultSection = el("div", "section");
  resultSection.append(el("h3", "", "Result"));
  const resultTree = el("div", "schema-tree");
  resultTree.append(renderSchemaTree(method.result.schema, method.result.name || "result", false, new Set()));
  resultSection.append(resultTree);

  detailContainer.append(header, paramsSection, resultSection);
}

function openSchema(name) {
  const schema = state.spec?.components?.schemas?.[name];
  if (!schema || !schemaModal) return;
  schemaModalTitle.textContent = name;
  clear(schemaModalBody);
  schemaModalBody.append(renderSchemaTree(schema, name, false, new Set()));
  schemaModal.hidden = false;
}

function closeSchema() {
  if (!schemaModal) return;
  schemaModal.hidden = true;
}

function renderSchemaTree(schema, keyLabel, required, seenRefs) {
  const template = document.getElementById("schema-node-template");
  const wrapper = template.content.firstElementChild.cloneNode(true);
  const label = wrapper.querySelector(".schema-key");
  const type = wrapper.querySelector(".schema-type");
  const flags = wrapper.querySelector(".schema-flags");
  const body = wrapper.querySelector(".schema-body");

  label.textContent = keyLabel || schema?.title || "value";
  type.textContent = schemaTypeLabel(schema);
  const flagParts = [];
  if (required) flagParts.push("required");
  if (schema?.deprecated) flagParts.push("deprecated");
  if (schema?.readOnly) flagParts.push("readOnly");
  flags.textContent = flagParts.length ? `(${flagParts.join(", ")})` : "";

  if (!schema) {
    body.append(el("div", "notice", "No schema available."));
    return wrapper;
  }

  let currentSchema = schema;
  if (schema.$ref) {
    const ref = schema.$ref;
    if (seenRefs.has(ref)) {
      body.append(el("div", "notice", `Circular ref: ${refName(ref)}`));
      return wrapper;
    }
    seenRefs.add(ref);
    const resolved = resolveRef(ref);
    if (resolved) currentSchema = resolved;
    const refNote = el("div", "notice", `Ref: ${ref}`);
    body.append(refNote);
  }

  if (currentSchema.description) {
    const desc = el("div", "notice", currentSchema.description);
    desc.style.whiteSpace = "pre-wrap";
    body.append(desc);
  }

  if (currentSchema.enum) {
    body.append(el("div", "notice", `Enum: ${currentSchema.enum.join(", ")}`));
  }

  if (currentSchema.properties) {
    const requiredList = new Set(currentSchema.required || []);
    for (const [key, value] of Object.entries(currentSchema.properties)) {
      body.append(renderSchemaTree(value, key, requiredList.has(key), new Set(seenRefs)));
    }
  }

  if (currentSchema.items) {
    body.append(renderSchemaTree(currentSchema.items, "items", false, new Set(seenRefs)));
  }

  if (currentSchema.oneOf) {
    currentSchema.oneOf.forEach((option, index) => {
      body.append(renderSchemaTree(option, `oneOf ${index + 1}`, false, new Set(seenRefs)));
    });
  }

  if (currentSchema.anyOf) {
    currentSchema.anyOf.forEach((option, index) => {
      body.append(renderSchemaTree(option, `anyOf ${index + 1}`, false, new Set(seenRefs)));
    });
  }

  if (currentSchema.allOf) {
    currentSchema.allOf.forEach((option, index) => {
      body.append(renderSchemaTree(option, `allOf ${index + 1}`, false, new Set(seenRefs)));
    });
  }

  return wrapper;
}

function buildTrySection(method) {
  const section = el("div", "section");
  section.append(el("h3", "", "Try It"));

  const wrap = el("div", "tryout");

  const idRow = el("div", "row");
  idRow.append(el("label", "notice", "Request ID"));
  const idInput = el("input");
  idInput.value = String(state.requestId);
  idRow.append(idInput);

  const headersRow = el("div", "row");
  headersRow.append(el("label", "notice", "Headers (JSON object)"));
  const headersInput = el("textarea");
  headersInput.value = loadSetting("rpcHeaders") || "{\n  \"Content-Type\": \"application/json\"\n}";
  headersRow.append(headersInput);


  const rawRow = el("div", "row");
  rawRow.append(el("label", "notice", "Params (JSON array)"));
  const rawParams = el("textarea");
  const exampleParams = extractExampleParamsFromDescription(method);
  rawParams.value = JSON.stringify(
    exampleParams ?? buildDefaultParams(method.params || []),
    null,
    2
  );
  rawRow.append(rawParams);

  const formRow = el("div", "row");
  formRow.append(el("label", "notice", "Param inputs"));
  const form = el("div", "param-grid");
  const paramInputs = [];

  (method.params || []).forEach((param) => {
    const field = el("div", "row");
    const label = el("label", "notice", `${param.name} (${schemaTypeLabel(param.schema)})`);
    const input = document.createElement(param.schema?.type === "object" || param.schema?.type === "array" ? "textarea" : "input");
    const exampleValue =
      exampleParams && Array.isArray(exampleParams) ? exampleParams[paramInputs.length] : schemaExample(param.schema);
    input.value =
      exampleValue === null || exampleValue === undefined ? "" : JSON.stringify(exampleValue, null, 2);
    field.append(label, input);
    form.append(field);
    paramInputs.push({ input, schema: param.schema });
  });

  if (!(method.params && method.params.length)) {
    form.append(el("div", "notice", "This method has no params."));
  }

  formRow.append(form);

  const actions = el("div", "actions");
  const buildBtn = el("button", "secondary", "Build Params");
  const sendBtn = el("button", "primary", "Send Request");
  actions.append(buildBtn, sendBtn);

  const response = el("pre", "response", "Response will appear here.");

  function setResponseText(text) {
    response.textContent = text;
  }

  function setResponseJson(json) {
    const pretty = JSON.stringify(json, null, 2);
    if (window.hljs && window.hljs.getLanguage("json")) {
      const highlighted = window.hljs.highlight(pretty, { language: "json" }).value;
      response.innerHTML = `<code class="hljs language-json">${highlighted}</code>`;
      return;
    }
    response.textContent = pretty;
  }
  const curlRow = el("div", "curl-row");
  const curlLabel = el("div", "notice", "curl");
  const curlPre = el("pre", "curl-pre");
  const curlCopyBtn = el("button", "secondary curl-copy", "Copy");
  curlRow.append(curlLabel, curlPre, curlCopyBtn);
  let syncing = false;

  function updateInputsFromRaw() {
    if (syncing) return;
    let params;
    try {
      params = JSON.parse(rawParams.value || "[]");
    } catch (_) {
      return;
    }
    if (!Array.isArray(params)) return;
    syncing = true;
    paramInputs.forEach(({ input, schema }, index) => {
      const value = params[index];
      if (value === undefined) {
        input.value = "";
        return;
      }
      if (typeof value === "string") {
        input.value = value;
        return;
      }
      try {
        input.value = JSON.stringify(value, null, 2);
      } catch (_) {
        input.value = String(value);
      }
      if (!input.value && schema) {
        const example = schemaExample(schema);
        input.value = example === undefined ? "" : JSON.stringify(example, null, 2);
      }
    });
    syncing = false;
  }

  function updateRawFromInputs() {
    if (syncing) return;
    syncing = true;
    const params = paramInputs.map(({ input, schema }) => {
      const raw = input.value.trim();
      if (!raw) return schemaExample(schema);
      try {
        return JSON.parse(raw);
      } catch (_) {
        return raw;
      }
    });
    rawParams.value = JSON.stringify(params, null, 2);
    syncing = false;
  }

  buildBtn.addEventListener("click", () => {
    updateRawFromInputs();
  });

  function buildPayload() {
    const idValue = idInput.value ? Number(idInput.value) || idInput.value : state.requestId;
    let params = [];
    try {
      params = JSON.parse(rawParams.value || "[]");
    } catch (err) {
      throw new Error(`Params JSON error: ${err.message}`);
    }
    return {
      jsonrpc: "2.0",
      id: idValue,
      method: method.name,
      params,
    };
  }

  function buildCurlCommand(endpoint, headers, payload) {
    const headerLines = Object.entries(headers || {}).map(
      ([k, v]) => `-H ${JSON.stringify(`${k}: ${v}`)}`
    );
    const data = JSON.stringify(payload).replace(/'/g, "'\"'\"'");
    const dataArg = `'${data}'`;
    return [
      "curl",
      "-X POST",
      JSON.stringify(endpoint),
      ...headerLines,
      "--data-raw",
      dataArg,
    ].join(" ");
  }

  function updateCurlPreview() {
    const endpoint = endpointInput.value.trim() || DEFAULT_ENDPOINT;
    let headers = {};
    try {
      headers = JSON.parse(headersInput.value || "{}");
    } catch (err) {
      curlPre.textContent = `Header JSON error: ${err.message}`;
      return;
    }
    let payload;
    try {
      payload = buildPayload();
    } catch (err) {
      curlPre.textContent = err.message;
      return;
    }
    const curl = buildCurlCommand(endpoint, { "Content-Type": "application/json", ...getAuthHeaders(), ...headers }, payload);
    curlPre.textContent = curl;
  }

  rawParams.addEventListener("change", updateInputsFromRaw);
  rawParams.addEventListener("input", updateInputsFromRaw);
  paramInputs.forEach(({ input }) => {
    input.addEventListener("input", updateRawFromInputs);
    input.addEventListener("change", updateRawFromInputs);
  });

  curlCopyBtn.addEventListener("click", async () => {
    const curl = curlPre.textContent || "";
    if (!curl.trim()) return;
    try {
      await navigator.clipboard.writeText(curl);
      setResponseText("Copied curl command to clipboard.");
    } catch (_) {
      setResponseText(curl);
    }
  });

  sendBtn.addEventListener("click", async () => {
    let payload;
    try {
      payload = buildPayload();
    } catch (err) {
      setResponseText(err.message);
      return;
    }

    const endpoint = endpointInput.value.trim() || DEFAULT_ENDPOINT;
    let headers = {};
    try {
      headers = JSON.parse(headersInput.value || "{}");
    } catch (err) {
      setResponseText(`Header JSON error: ${err.message}`);
      return;
    }

    setResponseText("Sending request...");

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders(), ...headers },
        body: JSON.stringify(payload),
      });
      const text = await res.text();
      try {
        const json = JSON.parse(text);
        setResponseJson(json);
      } catch (_) {
        setResponseText(text);
      }
    } catch (err) {
      setResponseText(`Request failed: ${err.message}`);
    }

    state.requestId += 1;
    idInput.value = String(state.requestId);
    saveSetting("rpcEndpoint", endpoint);
    saveSetting("rpcHeaders", headersInput.value);
    updateCurlPreview();
  });

  endpointInput.addEventListener("input", updateCurlPreview);
  authTokenInput.addEventListener("input", updateCurlPreview);
  headersInput.addEventListener("input", updateCurlPreview);
  idInput.addEventListener("input", updateCurlPreview);
  rawParams.addEventListener("input", updateCurlPreview);
  rawParams.addEventListener("change", updateCurlPreview);
  paramInputs.forEach(({ input }) => {
    input.addEventListener("input", updateCurlPreview);
    input.addEventListener("change", updateCurlPreview);
  });

  updateCurlPreview();
  wrap.append(idRow, headersRow, rawRow, formRow, actions, curlRow, response);
  section.append(wrap);
  return section;
}

function buildSubscriptionTrySection(topic) {
  const section = el("div", "section");
  section.append(el("h3", "", "Try It (WebSocket)"));

  const wrap = el("div", "tryout");

  const wsControlRow = el("div", "row");
  const wsStatus = el("div", "notice", "Disconnected");
  wsControlRow.append(wsStatus);

  const topicRow = el("div", "row");
  topicRow.append(el("label", "notice", "Topic"));
  const topicValue = el("input");
  topicValue.value = topic || SUBSCRIPTION_TOPICS[0];
  topicValue.readOnly = true;
  topicRow.append(topicValue);

  const idRow = el("div", "row");
  idRow.append(el("label", "notice", "Request ID"));
  const idInput = el("input");
  idInput.value = String(state.requestId);
  idRow.append(idInput);

  const subIdRow = el("div", "row");
  subIdRow.append(el("label", "notice", "Subscription ID"));
  const subIdInput = el("input");
  subIdInput.placeholder = "0x...";
  subIdInput.readOnly = true;
  subIdRow.append(subIdInput);

  const actions = el("div", "actions");
  const subscribeBtn = el("button", "primary subscribe-btn", "Subscribe");
  const unsubscribeBtn = el("button", "secondary unsubscribe-btn", "Unsubscribe");
  actions.append(subscribeBtn, unsubscribeBtn);

  const prettyRow = el("div", "row");
  prettyRow.append(el("label", "notice", "Log Format"));
  const prettyToggle = el("div", "mode-toggle");
  const rawBtn = el("button", "mode-btn", "Raw");
  const prettyBtn = el("button", "mode-btn active", "Pretty");
  prettyToggle.append(rawBtn, prettyBtn);
  prettyRow.append(prettyToggle);
  let prettyEnabled = true;

  const wsLog = el("div", "ws-log", "");
  const statusLine = el("div", "notice", "");

  let ws = null;
  let wsConnecting = null;
  const pending = new Map();
  const activeSubs = new Set();
  const subHint = el("div", "notice", "Not subscribed yet.");

  function setWsStatus(text, ok) {
    wsStatus.textContent = text;
    wsStatus.classList.toggle("ws-ok", Boolean(ok));
  }

  const wsHistory = [];
  const SCROLL_THRESHOLD = 24;

  function formatTimeStamp(date) {
    const pad = (value, size = 2) => String(value).padStart(size, "0");
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(
      date.getMilliseconds(),
      3
    )}`;
  }

  function renderWsEntry(entry) {
    const time = formatTimeStamp(entry.timestamp);
    const header = `${time} ${formatWsHeader(entry.prettyPayload || entry.rawPayload, entry.direction)}`;
    if (prettyEnabled && entry.prettyPayload) {
      const pretty = JSON.stringify(entry.prettyPayload, null, 2);
      let body = escapeHtml(pretty);
      if (window.hljs && window.hljs.getLanguage("json")) {
        body = window.hljs.highlight(pretty, { language: "json" }).value;
      }
      wsLog.insertAdjacentHTML(
        "beforeend",
        `<div class="ws-entry"><div class="ws-entry-head">${escapeHtml(
          header
        )}</div><pre><code class="hljs language-json">${body}</code></pre></div>`
      );
    } else {
      wsLog.insertAdjacentHTML(
        "beforeend",
        `<div class="ws-entry"><div class="ws-entry-head">${escapeHtml(
          header
        )}</div><pre class="ws-raw">${escapeHtml(entry.raw)}</pre></div>`
      );
    }
  }

  function appendWsEntry(entry) {
    const wasAtBottom =
      wsLog.scrollHeight - wsLog.scrollTop - wsLog.clientHeight < SCROLL_THRESHOLD;
    if (!entry.timestamp) {
      entry.timestamp = new Date();
    }
    if (!entry.rawPayload && entry.prettyPayload) {
      entry.rawPayload = entry.prettyPayload;
    }
    wsHistory.push(entry);
    renderWsEntry(entry);
    if (wasAtBottom) {
      wsLog.scrollTop = wsLog.scrollHeight;
    }
  }

  function rerenderWsHistory() {
    const wasAtBottom =
      wsLog.scrollHeight - wsLog.scrollTop - wsLog.clientHeight < SCROLL_THRESHOLD;
    const prevScrollTop = wsLog.scrollTop;
    wsLog.innerHTML = "";
    wsHistory.forEach(renderWsEntry);
    if (wasAtBottom) {
      wsLog.scrollTop = wsLog.scrollHeight;
    } else {
      wsLog.scrollTop = prevScrollTop;
    }
  }

  function normalizeWsPayload(payload) {
    if (!payload || typeof payload !== "object") return payload;
    const next = { ...payload };
    if (next.params && typeof next.params === "object") {
      const params = { ...next.params };
      if (typeof params.result === "string") {
        const trimmed = params.result.trim();
        if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
          try {
            params.result = JSON.parse(trimmed);
          } catch (_) { }
        }
      }
      next.params = params;
    }
    return next;
  }

  function formatWsHeader(payload, direction) {
    const arrow = direction === "out" ? "→" : "←";
    if (!payload || typeof payload !== "object") {
      return `${arrow} message`;
    }
    const label = payload.method || (payload.result !== undefined ? "result" : "message");
    const idPart = payload.id !== undefined ? ` #${payload.id}` : "";
    return `${arrow} ${label}${idPart}`;
  }

  function updateSubscriptionButtons() {
    const hasActive = activeSubs.size > 0 || Boolean(subIdInput.value.trim());
    subscribeBtn.disabled = hasActive;
    unsubscribeBtn.disabled = !hasActive;
    subHint.textContent = hasActive ? "Subscribed. You can unsubscribe." : "Not subscribed yet.";
  }

  function updateWsStatusLabel(connected) {
    if (!connected) {
      setWsStatus("Disconnected", false);
      return;
    }
    const count = activeSubs.size;
    setWsStatus(count ? `Connected (${count} active)` : "Connected", true);
  }

  function connectWs() {
    const url = endpointInput.value.trim();
    if (!url) {
      statusLine.textContent = "WebSocket endpoint is required.";
      return Promise.reject(new Error("missing endpoint"));
    }
    saveSetting("rpcWsEndpoint", url);
    setWsStatus("Connecting...", false);
    ws = new WebSocket(url);
    return new Promise((resolve, reject) => {
      ws.onopen = () => {
        updateWsStatusLabel(true);
        resolve();
      };
      ws.onclose = () => {
        updateWsStatusLabel(false);
        updateSubscriptionButtons();
      };
      ws.onerror = () => {
        setWsStatus("Error", false);
        reject(new Error("WebSocket error"));
      };
      ws.onmessage = (event) => {
        const raw = event.data;
        if (prettyEnabled) {
          try {
            const parsed = normalizeWsPayload(JSON.parse(raw));
            appendWsEntry({
              direction: "in",
              raw: `← ${raw}`,
              prettyPayload: parsed,
              rawPayload: parsed,
            });
          } catch (_) {
            appendWsEntry({ direction: "in", raw: `← ${raw}`, prettyPayload: null });
          }
        } else {
          appendWsEntry({ direction: "in", raw: `← ${raw}`, prettyPayload: null });
        }
        try {
          const json = JSON.parse(event.data);
          if (json && json.id !== undefined && pending.has(json.id)) {
            const info = pending.get(json.id);
            pending.delete(json.id);
            if (info.action === "subscribe" && typeof json.result === "string") {
              activeSubs.add(json.result);
              subIdInput.value = json.result;
              updateWsStatusLabel(true);
              updateSubscriptionButtons();
            }
            if (info.action === "unsubscribe" && json.result === true) {
              if (info.target) activeSubs.delete(info.target);
              updateWsStatusLabel(true);
              if (activeSubs.size === 0) {
                subIdInput.value = "";
              }
              updateSubscriptionButtons();
              if (activeSubs.size === 0) {
                ws.close();
              }
            }
          }
        } catch (_) { }
      };
    });
  }

  async function ensureWsConnected() {
    if (ws && ws.readyState === WebSocket.OPEN) return;
    if (wsConnecting) return wsConnecting;
    wsConnecting = connectWs().finally(() => {
      wsConnecting = null;
    });
    return wsConnecting;
  }

  async function sendWs(methodName, params) {
    try {
      await ensureWsConnected();
    } catch (_) {
      statusLine.textContent = "WebSocket connection failed.";
      return;
    }
    const idValue = idInput.value ? Number(idInput.value) || idInput.value : state.requestId;
    const payload = {
      jsonrpc: "2.0",
      id: idValue,
      method: methodName,
      params,
    };
    const message = JSON.stringify(payload);
    if (methodName === "subscribe") {
      pending.set(idValue, { action: "subscribe" });
    } else if (methodName === "unsubscribe") {
      pending.set(idValue, { action: "unsubscribe", target: params[0] });
    }
    ws.send(message);
    appendWsEntry({
      direction: "out",
      raw: `→ ${message}`,
      prettyPayload: prettyEnabled ? payload : null,
      rawPayload: payload,
    });
    statusLine.textContent = "Sent via WebSocket.";
    state.requestId += 1;
    idInput.value = String(state.requestId);
  }

  subscribeBtn.addEventListener("click", () => {
    sendWs("subscribe", [topicValue.value]);
  });

  unsubscribeBtn.addEventListener("click", () => {
    const subId = subIdInput.value.trim();
    if (!subId) {
      statusLine.textContent = "Subscription ID is required.";
      return;
    }
    sendWs("unsubscribe", [subId]);
  });

  updateSubscriptionButtons();

  function setPretty(enabled) {
    prettyEnabled = enabled;
    rawBtn.classList.toggle("active", !enabled);
    prettyBtn.classList.toggle("active", enabled);
    rerenderWsHistory();
  }

  rawBtn.addEventListener("click", () => setPretty(false));
  prettyBtn.addEventListener("click", () => setPretty(true));

  wrap.append(
    wsControlRow,
    topicRow,
    idRow,
    subIdRow,
    actions,
    prettyRow,
    subHint,
    wsLog,
    statusLine
  );
  section.append(wrap);
  return section;
}

function renderTryPanel() {
  clear(tryoutPanel);
  if (state.selectedSubscriptionTopic) {
    tryoutPanel.append(buildSubscriptionTrySection(state.selectedSubscriptionTopic));
    return;
  }
  if (state.selectedMethod) {
    tryoutPanel.append(buildTrySection(state.selectedMethod));
  }
}

function buildDefaultParams(params) {
  return params.map((param) => schemaExample(param.schema));
}

function init() {
  applyEndpointMode("http");

  const savedToken = loadSetting("rpcAuthToken");
  if (savedToken) authTokenInput.value = savedToken;

  authTokenInput.addEventListener("change", () => {
    saveSetting("rpcAuthToken", authTokenInput.value.trim());
  });

  endpointInput.addEventListener("change", () => {
    const value = endpointInput.value.trim();
    if (!value) return;
    saveEndpointValue(value);
  });

  const savedDetail = loadSetting("detailWidth");
  const savedTry = loadSetting("tryWidth");
  if (savedDetail && savedTry) {
    document.documentElement.style.setProperty("--detail-width", savedDetail);
    document.documentElement.style.setProperty("--try-width", savedTry);
  }

  searchInput.addEventListener("input", (event) => {
    state.searchTerm = event.target.value.trim().toLowerCase();
    renderTags();
  });

  clearTagBtn.addEventListener("click", () => {
    state.selectedTag = null;
    state.expandedTags.clear();
    renderTags();
  });

  detailContainer.addEventListener("click", (event) => {
    const link = event.target.closest("a[data-schema]");
    if (!link) return;
    event.preventDefault();
    openSchema(link.dataset.schema);
  });

  schemaModalClose?.addEventListener("click", closeSchema);
  schemaModalBackdrop?.addEventListener("click", closeSchema);

  if (panelResizer) {
    let isDragging = false;

    const onMove = (event) => {
      if (!isDragging) return;
      const app = document.querySelector(".app");
      const rect = app.getBoundingClientRect();
      const left = rect.left + 280 + 18;
      const right = rect.right - 18;
      const x = Math.min(Math.max(event.clientX, left + 160), right - 160);
      const detailWidth = x - left;
      const tryWidth = right - x;
      const detail = `${detailWidth}px`;
      const trypx = `${tryWidth}px`;
      document.documentElement.style.setProperty("--detail-width", detail);
      document.documentElement.style.setProperty("--try-width", trypx);
      saveSetting("detailWidth", detail);
      saveSetting("tryWidth", trypx);
    };

    const onUp = () => {
      isDragging = false;
      document.body.style.cursor = "";
    };

    panelResizer.addEventListener("pointerdown", (event) => {
      isDragging = true;
      document.body.style.cursor = "col-resize";
      panelResizer.setPointerCapture(event.pointerId);
    });

    panelResizer.addEventListener("pointermove", onMove);
    panelResizer.addEventListener("pointerup", onUp);
    panelResizer.addEventListener("pointercancel", onUp);

    panelResizer.addEventListener("dblclick", () => {
      document.documentElement.style.removeProperty("--detail-width");
      document.documentElement.style.removeProperty("--try-width");
      saveSetting("detailWidth", "");
      saveSetting("tryWidth", "");
    });
  }

  fetch(SPEC_URL)
    .then((res) => res.json())
    .then((spec) => {
      state.spec = spec;
      buildSchemaLinker();
      state.tags = buildTags(spec);
      state.methods = indexMethods(spec.methods || []);
      state.subscriptionMethod = state.methods.find((m) => m.name === "subscribe") || null;
      DEFAULT_METHOD = state.methods.length ? state.methods[0].name : null;
      state.expandedTags = new Set(state.tags.map((tag) => tag.name));
      renderTags();
      if (!location.hash && DEFAULT_METHOD) {
        history.replaceState(null, "", `#method=${encodeURIComponent(DEFAULT_METHOD)}`);
      }
      const hash = decodeURIComponent(location.hash.replace("#", ""));
      const topicMatch = hash.match(/topic=([^&]+)/);
      if (topicMatch) {
        const topic = topicMatch[1];
        if (SUBSCRIPTION_TOPICS.includes(topic)) {
          selectSubscriptionTopic(topic);
          return;
        }
      }
      const match = hash.match(/method=([^&]+)/);
      if (match) {
        const name = match[1];
        const found = state.methods.find((m) => m.name === name);
        if (found && name !== "subscribe" && name !== "unsubscribe") {
          selectMethod(found);
        } else if (SUBSCRIPTION_TOPICS.length) {
          selectSubscriptionTopic(SUBSCRIPTION_TOPICS[0]);
        }
      }
    })
    .catch((err) => {
      detailContainer.innerHTML = "";
      const error = el("div", "empty-state");
      error.append(el("h2", "", "Failed to load OpenRPC spec"));
      const msg = el(
        "p",
        "",
        `${err.message}. If you opened this via file://, run a local server (e.g. "python -m http.server" in docs) and visit http://localhost:8000`
      );
      error.append(msg);
      detailContainer.append(error);
    });
}

init();
