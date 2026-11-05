/** `.bin` files are imported as bytes (a `Data` module). */
declare module "*.bin" {
  const data: ArrayBuffer;
  export default data;
}
