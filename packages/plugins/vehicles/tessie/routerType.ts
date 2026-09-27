import type { createAppRouter } from "../../../server/src/trpc/root.ts";
import type { createTessieRouter } from "./server/router.ts";

export type TessieAppRouter = ReturnType<
  typeof createAppRouter<
    { tessie: ReturnType<typeof createTessieRouter> },
    Record<string, never>,
    Record<string, never>
  >
>;
