import { fetchHandler } from "./router.js";
import { fail, secureResponse } from "./responses.js";
import { exactRun } from "./scans.js";
import { findArtifact } from "./artifacts.js";

export default {
  async fetch(request, env, ctx) {
    try {
      return await fetchHandler(request, env, ctx);
    } catch (error) {
      return secureResponse(fail(error), { noStore: true });
    }
  },
};

export const internals = { exactRun, findArtifact };
