// Reads the HTTPS certificate of a tab. Chrome has no extension API for this, so we attach the
// DevTools debugger briefly and read the Security domain's visible security state.

const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0'));

function readLen(d, i) {
  let len = d[i++];
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let k = 0; k < n; k++) len = len * 256 + d[i++];
  }
  return [len, i];
}

// Subject Alternative Names (OID 2.5.29.17) from a DER certificate.
function readSans(der) {
  const oid = [0x06, 0x03, 0x55, 0x1d, 0x11];
  let i = -1;
  for (let k = 0; k + oid.length <= der.length && i < 0; k++) {
    if (oid.every((b, j) => der[k + j] === b)) i = k + oid.length;
  }
  if (i < 0) return [];
  if (der[i] === 0x01) i += 3; // optional "critical" BOOLEAN
  if (der[i++] !== 0x04) return []; // OCTET STRING wrapper
  [, i] = readLen(der, i);
  if (der[i++] !== 0x30) return []; // GeneralNames SEQUENCE
  let len;
  [len, i] = readLen(der, i);
  const end = i + len;
  const names = [];
  while (i < end) {
    const tag = der[i++];
    [len, i] = readLen(der, i);
    const val = der.slice(i, i + len);
    i += len;
    if (tag === 0x82) names.push(new TextDecoder().decode(val));
    else if (tag === 0x87) names.push(val.length === 4 ? [...val].join('.') : hex(val).join(':'));
  }
  return names;
}

function hostMatches(host, san) {
  if (san.startsWith('*.')) {
    const rest = san.slice(1);
    return host.endsWith(rest) && !host.slice(0, -rest.length).includes('.') && host.length > rest.length;
  }
  return host.toLowerCase() === san.toLowerCase();
}

async function describeCertificate(state, url) {
  const host = new URL(url).hostname;
  const cs = state?.certificateSecurityState;
  if (!cs) {
    return `No HTTPS certificate: the page ${url} was not loaded over a certificate-secured connection ` +
      `(security state: ${state?.securityState || 'unknown'}).`;
  }
  const chain = (cs.certificate || []).map(b64ToBytes);
  const leaf = chain[0];
  const sans = leaf ? readSans(leaf) : [];
  const fingerprint = leaf
    ? hex(new Uint8Array(await crypto.subtle.digest('SHA-256', leaf))).join(':').toUpperCase()
    : null;
  const fmt = (s) => new Date(s * 1000).toISOString();
  const daysLeft = Math.floor((cs.validTo * 1000 - Date.now()) / 86400000);
  const warnings = [
    cs.certificateHasWeakSignature && 'weak signature algorithm',
    cs.certificateHasSha1Signature && 'SHA-1 signature',
    cs.obsoleteSslProtocol && 'obsolete TLS protocol',
    cs.obsoleteSslKeyExchange && 'obsolete key exchange',
    cs.obsoleteSslCipher && 'obsolete cipher',
    cs.obsoleteSslSignature && 'obsolete signature',
    cs.certificateNetworkError && `certificate error: ${cs.certificateNetworkError}`,
    !cs.modernSSL && 'connection is not "modern" SSL',
  ].filter(Boolean);

  const lines = [
    `HTTPS certificate for ${host} (${url})`,
    `Connection security state: ${state.securityState}`,
    `Subject: ${cs.subjectName}`,
    `Subject alternative names: ${sans.length ? sans.join(', ') : '(none found)'}`,
    sans.length ? `Covers ${host}: ${sans.some((s) => hostMatches(host, s)) ? 'yes' : 'NO'}` : null,
    `Issuer: ${cs.issuer}`,
    `Valid from: ${fmt(cs.validFrom)}`,
    `Valid until: ${fmt(cs.validTo)} (${daysLeft >= 0 ? `${daysLeft} days remaining` : `EXPIRED ${-daysLeft} days ago`})`,
    `TLS protocol: ${cs.protocol}`,
    `Key exchange: ${[cs.keyExchange, cs.keyExchangeGroup].filter(Boolean).join(' / ') || 'n/a'}`,
    `Cipher: ${cs.cipher}${cs.mac ? ` with ${cs.mac}` : ''}`,
    `Certificates sent in chain: ${chain.length}`,
    fingerprint ? `Leaf SHA-256 fingerprint: ${fingerprint}` : null,
    `Warnings: ${warnings.length ? warnings.join('; ') : 'none'}`,
  ];
  return lines.filter(Boolean).join('\n');
}

// Returns a text description of the certificate used by the given tab.
async function readCertificate(tab) {
  if (!tab?.id || !/^https?:/.test(tab.url || '')) {
    throw new Error('The open page is not an http(s) page.');
  }
  const target = { tabId: tab.id };
  await chrome.debugger.attach(target, '1.3');
  try {
    const state = await new Promise((resolve, reject) => {
      const done = (fn, v) => {
        clearTimeout(timer);
        chrome.debugger.onEvent.removeListener(onEvent);
        fn(v);
      };
      const onEvent = (src, method, params) => {
        if (src.tabId === tab.id && method === 'Security.visibleSecurityStateChanged') {
          done(resolve, params.visibleSecurityState);
        }
      };
      const timer = setTimeout(() => done(reject, new Error('Timed out reading the certificate.')), 5000);
      chrome.debugger.onEvent.addListener(onEvent);
      // Enabling the Security domain immediately reports the current state.
      chrome.debugger.sendCommand(target, 'Security.enable').catch((e) => done(reject, e));
    });
    return await describeCertificate(state, tab.url);
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}
