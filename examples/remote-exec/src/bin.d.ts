/** `.bin` files are imported as bytes: Wrangler's default rules make them `Data` modules. */
declare module "*.bin" {
  const data: ArrayBuffer;
  export default data;
}
