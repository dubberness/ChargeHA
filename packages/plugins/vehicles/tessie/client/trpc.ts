import { widenTrpc } from "../../../hostUi.ts";
import type { TessieAppRouter } from "../routerType.ts";

export const trpc = widenTrpc<TessieAppRouter>();
