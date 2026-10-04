// Tunnel File Wizard — universal brand block.
//
// The single authority for the header brand on every page: the admin-uploaded
// logo (one per light/dark mode), the animated tunnel-and-wizard icon, and the
// site name text. Previously this markup, its CSS, and its JS were copied
// across index.html / theme.js / app.css and kept drifting apart — now there
// is exactly one copy, here.
//
// Usage: put an empty element with [data-brand] where the brand goes and load
// this script before your page script, then call TFWBrand.mount():
//
//   <a class="brand" href="/" data-brand></a>
//   <script src="/brand.js"></script>
//
// TFWBrand.applyBranding(bootstrapData) applies the admin's Branding-panel
// choices (site name, show/hide icon/text) plus the footer version stamp. TFWBrand.setLogoMode('light'|'dark') swaps the uploaded logo to
// match the current mode.

(function () {
  // Brand CSS, injected once. The logo is a fixed 48px tall on desktop —
// big enough to be prominent, small enough to never break the header —
// and auto-caps at 40px on small screens. max-height + max-width together
// keep the aspect ratio intact, so any uploaded logo "just works".
  var BRAND_CSS = [
    '.brand-logo{width:auto;height:auto',
    'max-height:48px;max-width:322px;',
    'object-fit:contain;border-radius:6px;display:none;flex-shrink:0}',
    '.brand-logo.on{display:inline-block}',
    '@media (max-width:640px){',
    '  .brand-logo{max-height:40px;max-width:46vw}',
    '}',
    '.brand-icon{width:24px;height:24px;flex-shrink:0;overflow:visible}',
    '.brand-icon .tunnel-ring{fill:none;transition:stroke .25s}',
    '.brand-icon .tunnel-ring.r1{stroke:var(--accent-dim);stroke-width:1.6;opacity:.35}',
    '.brand-icon .tunnel-ring.r2{stroke:var(--accent-dim);stroke-width:1.6;opacity:.55}',
    '.brand-icon .tunnel-ring.r3{stroke:var(--accent);stroke-width:1.6;opacity:.85}',
    '.brand-icon .tunnel-core{fill:var(--accent);transform-origin:20px 20px;animation:tfw-tunnelPulse 2s ease-in-out infinite}',
    '.brand-icon .hat{fill:var(--accent)}',
    '.brand-icon .hat-star{fill:var(--accent);transform-origin:4.5px 1px;animation:tfw-hatTwinkle 2s ease-in-out infinite}',
    '.brand-icon .file-travel{transform-origin:0 0;animation:tfw-fileThroughTunnel 2.6s cubic-bezier(.55,0,.45,1) infinite}',
    '@keyframes tfw-tunnelPulse{0%,100%{transform:scale(1);opacity:.85}50%{transform:scale(1.25);opacity:1}}',
    '@keyframes tfw-hatTwinkle{0%,100%{opacity:.3}50%{opacity:1}}',
    '@keyframes tfw-fileThroughTunnel{',
    '  0%{transform:translate(-14px,-14px) scale(1);opacity:0}',
    '  12%{opacity:1}',
    '  82%{transform:translate(0,0) scale(.18);opacity:1}',
    '  100%{transform:translate(0,0) scale(.05);opacity:0}}',
  ].join('\n');

  // Animated brand icon: a file getting pulled through a tunnel by a wizard.
  // (Keyframes are prefixed tfw- so they can't collide with page styles.)
  var ICON_SVG =
    '<svg class="brand-icon" viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">' +
    '<circle class="tunnel-ring r1" cx="20" cy="20" r="17"/>' +
    '<circle class="tunnel-ring r2" cx="20" cy="20" r="12"/>' +
    '<circle class="tunnel-ring r3" cx="20" cy="20" r="7.5"/>' +
    '<circle class="tunnel-core" cx="20" cy="20" r="3"/>' +
    '<g class="hat" transform="translate(5,3) rotate(-18)">' +
    '<path d="M0 9 L4.5 0 L9 9 Z"/>' +
    '<rect x="-2" y="8" width="13" height="2" rx="1"/>' +
    '</g>' +
    '<circle class="hat-star" cx="4.5" cy="1" r="1.1"/>' +
    '<g transform="translate(20,20)">' +
    '<g class="file-travel">' +
    '<rect x="-3.5" y="-2.5" width="7" height="5" rx="0.8" fill="var(--text)"/>' +
    '<path d="M1 -2.5 L3.5 0 L1 0 Z" fill="var(--bg)"/>' +
    '</g></g></svg>';

  function ensureCss() {
    if (document.getElementById('tfw-brand-css')) return;
    var st = document.createElement('style');
    st.id = 'tfw-brand-css';
    st.textContent = BRAND_CSS;
    document.head.appendChild(st);
  }

  // Fill every [data-brand] slot with the standard brand markup.
  function mount() {
    ensureCss();
    var slots = document.querySelectorAll('[data-brand]');
    for (var i = 0; i < slots.length; i++) {
      var slot = slots[i];
      if (slot.getAttribute('data-brand-mounted')) continue;
      slot.setAttribute('data-brand-mounted', '1');
      slot.innerHTML =
        '<img class="brand-logo" id="brand-logo" alt="" />' +
        ICON_SVG +
        '<span class="brand-text">Tunnel File Wizard</span>';
    }
  }

  // Show the uploaded logo matching the current light/dark mode. The <img>
  // only reveals itself once the image actually loads; a 404 keeps it hidden
  // and the default icon shows instead (no flash of a broken image).
  function setLogoMode(mode) {
    var m = mode === 'light' ? 'light' : 'dark';
    var imgs = document.querySelectorAll('.brand-logo');
    for (var i = 0; i < imgs.length; i++) {
      (function (img) {
        img.onload = function () { img.classList.add('on'); };
        img.onerror = function () { img.classList.remove('on'); };
        var src = '/branding/logo-' + m;
        if (img.getAttribute('src') !== src) img.src = src;
      })(imgs[i]);
    }
  }

  // Apply one /api/bootstrap response: footer version stamp, admin-chosen
  // site name (header + tab title), and show/hide icon/text.
  function applyBranding(b) {
    if (!b) return;
    // Footer version stamp: proves at a glance whether an upgrade took effect.
    if (b.version) {
      var vers = document.querySelectorAll('.app-version');
      for (var i = 0; i < vers.length; i++) vers[i].textContent = 'v' + b.version;
    }
    // The admin can rename the site (admin panel > Branding).
    if (b.siteName) {
      var texts = document.querySelectorAll('.brand-text');
      for (var j = 0; j < texts.length; j++) texts[j].textContent = b.siteName;
      if (document.title.indexOf('Tunnel File Wizard') !== -1) {
        document.title = document.title.split('Tunnel File Wizard').join(b.siteName);
      }
    }
    var branding = b.branding || null;
    if (!branding) return;
    var showIcon = branding.showIcon !== false;
    var showText = branding.showText !== false;
    var icons = document.querySelectorAll('.brand-icon');
    for (var m2 = 0; m2 < icons.length; m2++) icons[m2].style.display = showIcon ? '' : 'none';
    var names = document.querySelectorAll('.brand-text');
    for (var n = 0; n < names.length; n++) names[n].style.display = showText ? '' : 'none';
  }

  window.TFWBrand = { mount: mount, setLogoMode: setLogoMode, applyBranding: applyBranding };
})();
