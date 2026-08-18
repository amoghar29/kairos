'use strict';

(function () {
  const LITERALS = { 'true': true, 'false': false, 'null': null, 'undefined': undefined };

  function resolve(expr, scope) {
    const key = expr.trim();
    if (key in LITERALS) return LITERALS[key];
    if (/^-?\d+(\.\d+)?$/.test(key)) return Number(key);
    if (/^'.*'$/.test(key) || /^".*"$/.test(key)) return key.slice(1, -1);

    const parts = key.split('.');
    let cur = scope;
    for (let i = 0; i < parts.length; i++) {
      if (cur === null || cur === undefined) return undefined;
      cur = cur[parts[i]];
    }
    return cur;
  }

  const BINDING = /\{\{([^}]*)\}\}/g;

  function evaluate(text, scope) {
    const whole = /^\s*\{\{([^}]*)\}\}\s*$/.exec(text);
    if (whole) return resolve(whole[1], scope);
    return text.replace(BINDING, (_, e) => {
      const v = resolve(e, scope);
      return v === null || v === undefined ? '' : String(v);
    });
  }

  const EVENTS = { onclick: 'click', onchange: 'change', oninput: 'input', onkeydown: 'keydown',
                   onkeyup: 'keyup', onsubmit: 'submit', onfocus: 'focus', onblur: 'blur' };
  const PROPS = { value: 'value', checked: 'checked', disabled: 'disabled', tabindex: 'tabIndex', selected: 'selected' };

  function applyStyle(el, v) {
    if (v && typeof v === 'object') {
      el.removeAttribute('style');
      for (const k in v) el.style.setProperty(k.replace(/[A-Z]/g, m => '-' + m.toLowerCase()), v[k]);
    } else if (v === null || v === undefined || v === '') {
      el.removeAttribute('style');
    } else {
      el.style.cssText = String(v);
    }
  }

  const CONTROL_ATTRS = { 'sc-if': true, 'sc-for': true, 'sc-as': true };

  function setAttr(el, name, value) {
    if (name.startsWith('hint-')) return;
    if (CONTROL_ATTRS[name]) return;
    const lower = name.toLowerCase();
    if (EVENTS[lower]) {
      const type = EVENTS[lower];
      el.__h = el.__h || {};
      if (el.__h[type]) el.removeEventListener(type, el.__h[type]);
      if (typeof value === 'function') {
        el.__h[type] = value;
        el.addEventListener(type, value);
      } else {
        delete el.__h[type];
      }
      return;
    }
    if (lower === 'style') return applyStyle(el, value);
    if (name === 'className') return void (el.className = value == null ? '' : String(value));
    if (PROPS[lower]) {
      const key = PROPS[lower];
      if (el[key] !== value) el[key] = value === null || value === undefined ? '' : value;
      if (key === 'disabled' || key === 'checked' || key === 'selected') {
        if (value) el.setAttribute(lower, ''); else el.removeAttribute(lower);
      }
      return;
    }
    if (value === false || value === null || value === undefined) el.removeAttribute(name);
    else el.setAttribute(name, value === true ? '' : String(value));
  }

  function expand(node, scope, out, controlDone) {
    if (node.nodeType === 3) {
      const raw = node.nodeValue;
      if (raw.indexOf('{{') === -1) { out.appendChild(document.createTextNode(raw)); return; }
      const v = evaluate(raw, scope);
      out.appendChild(document.createTextNode(v === null || v === undefined ? '' : String(v)));
      return;
    }
    if (node.nodeType !== 1) return;

    const tag = node.tagName.toLowerCase();

    if (tag === 'sc-if') {
      if (resolve(stripBraces(node.getAttribute('value')), scope)) expandChildren(node, scope, out);
      return;
    }

    if (tag === 'sc-for') {
      const list = resolve(stripBraces(node.getAttribute('list')), scope);
      const as = node.getAttribute('as') || 'item';
      if (!list || !list.length) return;
      for (let i = 0; i < list.length; i++) {
        const child = Object.create(scope);
        child[as] = list[i];
        child[as + 'Index'] = i;
        expandChildren(node, child, out);
      }
      return;
    }

    if (!controlDone) {
      if (node.hasAttribute('sc-if') && !resolve(stripBraces(node.getAttribute('sc-if')), scope)) return;

      if (node.hasAttribute('sc-for')) {
        const list = resolve(stripBraces(node.getAttribute('sc-for')), scope);
        const as = node.getAttribute('sc-as') || 'item';
        if (!list || !list.length) return;
        for (let i = 0; i < list.length; i++) {
          const child = Object.create(scope);
          child[as] = list[i];
          child[as + 'Index'] = i;
          expand(node, child, out, true);
        }
        return;
      }
    }

    const el = document.createElement(tag);
    const attrs = node.attributes;
    for (let i = 0; i < attrs.length; i++) {
      const a = attrs[i];
      setAttr(el, a.name === 'class' ? 'className' : a.name,
              a.value.indexOf('{{') === -1 ? a.value : evaluate(a.value, scope));
    }
    expandChildren(node, scope, el);
    out.appendChild(el);
  }

  function stripBraces(s) {
    if (!s) return 'false';
    const m = /^\s*\{\{([^}]*)\}\}\s*$/.exec(s);
    return m ? m[1] : s;
  }

  function expandChildren(node, scope, out) {
    const kids = node.childNodes;
    for (let i = 0; i < kids.length; i++) expand(kids[i], scope, out);
  }

  function morph(live, next) {
    const a = Array.prototype.slice.call(live.childNodes);
    const b = Array.prototype.slice.call(next.childNodes);
    for (let i = 0; i < b.length; i++) {
      const cur = a[i], want = b[i];
      if (!cur) { live.appendChild(want); continue; }
      if (cur.nodeType !== want.nodeType ||
          (cur.nodeType === 1 && cur.tagName !== want.tagName)) {
        live.replaceChild(want, cur);
        continue;
      }
      if (cur.nodeType === 3) {
        if (cur.nodeValue !== want.nodeValue) cur.nodeValue = want.nodeValue;
        continue;
      }
      syncAttrs(cur, want);
      morph(cur, want);
    }
    for (let i = b.length; i < a.length; i++) live.removeChild(a[i]);
  }

  function syncAttrs(live, next) {
    const na = next.attributes;
    for (let i = 0; i < na.length; i++) {
      if (live.getAttribute(na[i].name) !== na[i].value) live.setAttribute(na[i].name, na[i].value);
    }
    const la = live.attributes;
    for (let i = la.length - 1; i >= 0; i--) {
      if (!next.hasAttribute(la[i].name)) live.removeAttribute(la[i].name);
    }
    const nh = next.__h;
    if (live.__h) {
      for (const type in live.__h) {
        if (!nh || !nh[type]) { live.removeEventListener(type, live.__h[type]); delete live.__h[type]; }
      }
    }
    if (nh) {
      live.__h = live.__h || {};
      for (const type in nh) {
        if (live.__h[type]) live.removeEventListener(type, live.__h[type]);
        live.__h[type] = nh[type];
        live.addEventListener(type, nh[type]);
      }
    }
    if ('value' in next && next.value !== undefined && live.value !== next.value &&
        document.activeElement !== live) live.value = next.value;
    if ('checked' in next && live.checked !== next.checked) live.checked = next.checked;
    if ('disabled' in next && live.disabled !== next.disabled) live.disabled = next.disabled;
  }

  class KairosComponent {
    constructor(props, template, mount) {
      this.props = props || {};
      this.state = {};
      this._template = template;
      this._mount = mount;
      this._queued = false;
    }

    setState(patch) {
      Object.assign(this.state, typeof patch === 'function' ? patch(this.state) : patch);
      if (this._queued) return;
      this._queued = true;
      requestAnimationFrame(() => { this._queued = false; this.render(); });
    }

    scope() {
      const self = this;
      return new Proxy({}, {
        has: () => true,
        get(_, k) {
          if (k in self.state) return self.state[k];
          const v = self[k];
          return typeof v === 'function' ? v.bind(self) : v;
        }
      });
    }

    render() {
      const next = document.createDocumentFragment();
      const view = this.renderVals ? this.renderVals() : null;
      const base = this.scope();
      const scope = view ? new Proxy({}, {
        has: () => true,
        get(_, k) { return k in view ? view[k] : base[k]; }
      }) : base;
      expandChildren(this._template, scope, next);
      const staged = document.createElement('div');
      staged.appendChild(next);
      morph(this._mount, staged);
    }

    mount() {
      if (this.componentDidMount) this.componentDidMount();
      this.render();
    }

    unmount() {
      if (this.componentWillUnmount) this.componentWillUnmount();
    }
  }

  window.KairosComponent = KairosComponent;

  window.__bootDashboard = function (props) {
    const template = document.getElementById('app-template').content;
    const mount = document.getElementById('app');
    const c = new Component(props, template, mount);
    window.__dashboard = c;
    c.mount();
    window.addEventListener('beforeunload', () => c.unmount());
  };
})();
