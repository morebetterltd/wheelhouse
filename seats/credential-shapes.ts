export const CREDENTIAL_SHAPE_RE = [
  String.raw`xox[abpr]-[0-9][A-Za-z0-9-]{10,}`,
  String.raw`github_pat_[A-Za-z0-9_]{20,}`,
  String.raw`ghp_[A-Za-z0-9_]{20,}`,
  String.raw`sk-[A-Za-z0-9][A-Za-z0-9_-]{20,}`,
  String.raw`[0-9]{6,}:[A-Za-z0-9_-]{30,}`,
  String.raw`eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}`,
  String.raw`-----BEGIN (RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY-----`,
].join("|");
