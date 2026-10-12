import forge from "node-forge";

export interface Pem {
  cert: string;
  key: string;
}

const DAY = 86_400_000;

function baseCert(cn: string, days: number, serial: string): { cert: forge.pki.Certificate; keys: forge.pki.rsa.KeyPair } {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = serial;
  cert.validity.notBefore = new Date(Date.now() - DAY);
  cert.validity.notAfter = new Date(Date.now() + days * DAY);
  cert.setSubject([{ name: "commonName", value: cn }]);
  return { cert, keys };
}

/** Local certificate authority, generated at test time. */
export function createCa(name = "Site Audit Test CA", days = 365): Pem & { sign: (cn: string, days: number) => Pem } {
  const { cert, keys } = baseCert(name, days, "01");
  cert.setSubject([{ name: "commonName", value: name }, { name: "organizationName", value: name }]);
  cert.setIssuer(cert.subject.attributes);
  cert.setExtensions([{ name: "basicConstraints", cA: true }, { name: "keyUsage", keyCertSign: true, cRLSign: true }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  let serial = 2;
  return {
    cert: forge.pki.certificateToPem(cert),
    key: forge.pki.privateKeyToPem(keys.privateKey),
    sign: (cn, leafDays) => {
      const leaf = baseCert(cn, leafDays, (serial++).toString(16).padStart(2, "0"));
      leaf.cert.setIssuer(cert.subject.attributes);
      leaf.cert.setExtensions([
        { name: "basicConstraints", cA: false },
        { name: "extKeyUsage", serverAuth: true },
        { name: "subjectAltName", altNames: [{ type: 2, value: "localhost" }, { type: 7, ip: "127.0.0.1" }] },
      ]);
      leaf.cert.sign(keys.privateKey, forge.md.sha256.create());
      return { cert: forge.pki.certificateToPem(leaf.cert), key: forge.pki.privateKeyToPem(leaf.keys.privateKey) };
    },
  };
}

/** Self-signed certificate (not issued by any CA). */
export function selfSigned(cn = "localhost", days = 30): Pem {
  const { cert, keys } = baseCert(cn, days, "0a");
  cert.setIssuer(cert.subject.attributes);
  cert.setExtensions([{ name: "subjectAltName", altNames: [{ type: 2, value: "localhost" }, { type: 7, ip: "127.0.0.1" }] }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { cert: forge.pki.certificateToPem(cert), key: forge.pki.privateKeyToPem(keys.privateKey) };
}
