//#region src/bin.d.ts
/** Standalone status/diagnostics/PAT CLI for the dsh-qoder-plugin bundle. */
/** Execute one boot-free command. */
declare function run(argv: readonly string[]): Promise<number>;
//#endregion
export { run };