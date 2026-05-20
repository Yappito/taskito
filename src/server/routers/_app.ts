import { createTRPCRouter } from "../trpc";
import { projectRouter } from "./project";
import { taskRouter } from "./task";
import { tagRouter } from "./tag";
import { workflowRouter } from "./workflow";
import { searchRouter } from "./search";
import { userRouter } from "./user";
import { groupRouter } from "./group";
import { oidcRouter } from "./oidc";
import { customFieldRouter } from "./custom-field";
import { notificationRouter } from "./notification";
import { aiRouter } from "./ai";
import { analyticsRouter } from "./analytics";
import { dashboardRouter } from "./dashboard";
import { sprintRouter } from "./sprint";
import { timeLogRouter } from "./time-log";
import { automationRouter } from "./automation";
import { recurrenceRouter } from "./recurrence";
import { storageRouter } from "./storage";

/** Root tRPC router — all sub-routers mounted here */
export const appRouter = createTRPCRouter({
  project: projectRouter,
  task: taskRouter,
  tag: tagRouter,
  workflow: workflowRouter,
  customField: customFieldRouter,
  notification: notificationRouter,
  search: searchRouter,
  user: userRouter,
  group: groupRouter,
  oidc: oidcRouter,
  ai: aiRouter,
  analytics: analyticsRouter,
  dashboard: dashboardRouter,
  sprint: sprintRouter,
  timeLog: timeLogRouter,
  automation: automationRouter,
  recurrence: recurrenceRouter,
  storage: storageRouter,
});

/** Type export for the client */
export type AppRouter = typeof appRouter;
