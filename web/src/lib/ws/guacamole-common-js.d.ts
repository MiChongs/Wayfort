// Minimal ambient declaration for guacamole-common-js. The npm package
// doesn't ship its own .d.ts; we just need TS to accept the dynamic import.
// The real type structure is handled in guacamole-client.ts.
declare module "guacamole-common-js" {
  const G: unknown
  export default G
}
