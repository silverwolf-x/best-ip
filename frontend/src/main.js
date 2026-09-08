import { createTransport } from "./transport/index.js";
import { mountApp } from "./ui.js";

mountApp({ transport: createTransport(window.BEST_IP_CONFIG || {}), document });
