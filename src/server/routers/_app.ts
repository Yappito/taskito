import { createTRPCRouter } from "../trpc";
import { projectRouter } from "./project";
import { taskRouter } from "./task";
import { tagRouter } from "./tag";
import { workflowRouter } from "./workflow";
import { searchRouter } from "./search";
import { userRouter } from "./user";

/** Root tRPC router — all sub-routers mounted here */
export const appRouter = createTRPCRouter({
  project: projectRouter,
  task: taskRouter,
  tag: tagRouter,
  workflow: workflowRouter,
  search: searchRouter,
  user: userRouter,
});

/** Type export for the client */
export type AppRouter = typeof appRouter;
