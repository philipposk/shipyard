// The only thing the website can see about the desktop window: a flag that says it is the desktop app.
// (Use it to change a sentence or hide a button, for example `window.shipyardDesktop?.isDesktop`.)
const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("shipyardDesktop", {
  isDesktop: true,
  platform: process.platform,
});
