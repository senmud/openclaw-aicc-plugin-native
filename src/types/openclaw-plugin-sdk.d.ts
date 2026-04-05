/**
 * 类型占位声明：用于在本地无法安装 `@openclaw/plugin-sdk` 时仍可通过 TypeScript 编译。
 *
 * 运行时仍然需要 OpenClaw 提供真实的 `@openclaw/plugin-sdk` 包。
 * 在真实环境中，该声明会被真实类型覆盖/合并，不影响运行。
 */
declare module '@openclaw/plugin-sdk' {
  // OpenClaw 的真实类型由宿主/SDK 提供，这里仅做 any 占位。
  export type OpenClaw = any;
}

