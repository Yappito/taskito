import type { Prisma, StatusCategory, TaskPriority } from "@prisma/client";

const taskPriorities = ["none", "low", "medium", "high", "urgent"] as const satisfies readonly TaskPriority[];
const statusCategories = ["backlog", "todo", "active", "done", "cancelled"] as const satisfies readonly StatusCategory[];

type QueryOperator = "=" | "!=" | "in" | "not in" | ">" | ">=" | "<" | "<=" | "contains" | "~";
type QueryField =
  | "status"
  | "statusCategory"
  | "priority"
  | "assignee"
  | "creator"
  | "participant"
  | "tag"
  | "sprint"
  | "dueDate"
  | "createdAt"
  | "updatedAt"
  | "closedAt"
  | "archived"
  | "overdue"
  | "text"
  | "taskNumber";

export interface DashboardQueryDictionary {
  currentUserId: string;
  statuses: Array<{ id: string; name: string; category: StatusCategory }>;
  tags: Array<{ id: string; name: string }>;
  users: Array<{ id: string; name: string | null; email: string }>;
  sprints: Array<{ id: string; name: string; status: string }>;
}

export interface DashboardQueryResult {
  where: Prisma.TaskWhereInput;
  clauses: string[];
}

const fieldAliases: Record<string, QueryField> = {
  status: "status",
  statusid: "status",
  category: "statusCategory",
  statuscategory: "statusCategory",
  priority: "priority",
  assignee: "assignee",
  assigneeid: "assignee",
  owner: "assignee",
  creator: "creator",
  creatorid: "creator",
  reporter: "creator",
  participant: "participant",
  participantid: "participant",
  watcher: "participant",
  tag: "tag",
  tags: "tag",
  label: "tag",
  labels: "tag",
  sprint: "sprint",
  sprintid: "sprint",
  due: "dueDate",
  duedate: "dueDate",
  created: "createdAt",
  createdat: "createdAt",
  updated: "updatedAt",
  updatedat: "updatedAt",
  closed: "closedAt",
  closedat: "closedAt",
  archived: "archived",
  overdue: "overdue",
  text: "text",
  title: "text",
  summary: "text",
  key: "taskNumber",
  task: "taskNumber",
  tasknumber: "taskNumber",
};

function startOfDay(date: Date) {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function endOfDay(date: Date) {
  const copy = new Date(date);
  copy.setHours(23, 59, 59, 999);
  return copy;
}

function addDays(date: Date, days: number) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

function addMonths(date: Date, months: number) {
  const copy = new Date(date);
  copy.setMonth(copy.getMonth() + months);
  return copy;
}

function getStartOfWeek(date: Date) {
  const day = date.getDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  return startOfDay(addDays(date, diffToMonday));
}

function getEndOfWeek(date: Date) {
  return endOfDay(addDays(getStartOfWeek(date), 6));
}

function isWordBoundary(value: string | undefined) {
  return value === undefined || /\s|\(|\)/.test(value);
}

function splitOnTopLevelAnd(query: string) {
  const clauses: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let depth = 0;

  for (let index = 0; index < query.length; index += 1) {
    const char = query[index];
    const nextThree = query.slice(index, index + 3).toLowerCase();

    if (quote) {
      current += char;
      if (char === quote && query[index - 1] !== "\\") {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }

    if (char === "(") depth += 1;
    if (char === ")") depth = Math.max(0, depth - 1);

    if (depth === 0 && nextThree === "and" && isWordBoundary(query[index - 1]) && isWordBoundary(query[index + 3])) {
      const trimmed = current.trim();
      if (trimmed) clauses.push(trimmed);
      current = "";
      index += 2;
      continue;
    }

    current += char;
  }

  const trimmed = current.trim();
  if (trimmed) clauses.push(trimmed);
  return clauses;
}

function parseClause(clause: string) {
  const match = clause.match(/^([a-zA-Z][\w.]*)\s*(not\s+in|in|!=|>=|<=|=|>|<|~|contains)\s*(.+)$/i);
  if (!match) {
    throw new Error(`Could not parse query clause "${clause}". Use forms like status = Done or priority in (high, urgent).`);
  }

  const [, rawField, rawOperator, rawValue] = match;
  const field = fieldAliases[rawField.replace(/[._-]/g, "").toLowerCase()];
  if (!field) {
    throw new Error(`Unsupported query field "${rawField}".`);
  }

  return {
    field,
    operator: rawOperator.toLowerCase().replace(/\s+/g, " ") as QueryOperator,
    rawValue: rawValue.trim(),
  };
}

function stripQuotes(value: string) {
  const trimmed = value.trim();
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return trimmed.slice(1, -1).replace(/\\(["'])/g, "$1");
  }
  return trimmed;
}

function splitValueList(rawValue: string) {
  const trimmed = rawValue.trim();
  const listBody = trimmed.startsWith("(") && trimmed.endsWith(")") ? trimmed.slice(1, -1) : trimmed;
  const values: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < listBody.length; index += 1) {
    const char = listBody[index];
    if (quote) {
      current += char;
      if (char === quote && listBody[index - 1] !== "\\") {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }

    if (char === ",") {
      const value = stripQuotes(current);
      if (value) values.push(value);
      current = "";
      continue;
    }

    current += char;
  }

  const value = stripQuotes(current);
  if (value) values.push(value);
  return values;
}

function expectsList(operator: QueryOperator) {
  return operator === "in" || operator === "not in";
}

function isNegated(operator: QueryOperator) {
  return operator === "!=" || operator === "not in";
}

function normalizeToken(value: string) {
  return value.trim().toLowerCase();
}

function findByNameOrId<T extends { id: string; name: string }>(items: T[], value: string, noun: string) {
  const token = normalizeToken(value);
  const item = items.find((candidate) => candidate.id === value || candidate.name.toLowerCase() === token);
  if (!item) {
    throw new Error(`Unknown ${noun} "${value}".`);
  }
  return item;
}

function resolveUserId(users: DashboardQueryDictionary["users"], currentUserId: string, value: string) {
  const token = normalizeToken(value);
  if (token === "me" || token === "me()" || token === "currentuser" || token === "currentuser()") {
    return currentUserId;
  }
  if (["none", "null", "unassigned", "empty"].includes(token)) {
    return null;
  }

  const user = users.find((candidate) =>
    candidate.id === value ||
    candidate.email.toLowerCase() === token ||
    (candidate.name?.toLowerCase() === token)
  );
  if (!user) {
    throw new Error(`Unknown user "${value}".`);
  }
  return user.id;
}

function resolveSprintId(sprints: DashboardQueryDictionary["sprints"], value: string) {
  const token = normalizeToken(value);
  if (["none", "null", "empty", "nosprint"].includes(token)) {
    return null;
  }
  if (token === "active" || token === "active()") {
    const activeSprint = sprints.find((sprint) => sprint.status === "active");
    if (!activeSprint) {
      throw new Error("No active sprint exists in this project.");
    }
    return activeSprint.id;
  }
  return findByNameOrId(sprints, value, "sprint").id;
}

function resolveDate(value: string, boundary: "start" | "end" | "instant") {
  const token = normalizeToken(value);
  const now = new Date();

  if (token === "now" || token === "now()") return now;
  if (token === "today" || token === "today()") return boundary === "end" ? endOfDay(now) : startOfDay(now);
  if (token === "startofweek" || token === "startofweek()") return getStartOfWeek(now);
  if (token === "endofweek" || token === "endofweek()") return getEndOfWeek(now);

  const relative = token.match(/^([+-]?\d+)(d|w|m)$/);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2];
    const shifted = unit === "m" ? addMonths(now, amount) : addDays(now, amount * (unit === "w" ? 7 : 1));
    return boundary === "end" ? endOfDay(shifted) : boundary === "start" ? startOfDay(shifted) : shifted;
  }

  const dateOnly = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) {
    const parsed = new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]));
    return boundary === "end" ? endOfDay(parsed) : startOfDay(parsed);
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid date value "${value}".`);
  }
  return parsed;
}

function parseBoolean(value: string) {
  const token = normalizeToken(value);
  if (["true", "yes", "1"].includes(token)) return true;
  if (["false", "no", "0"].includes(token)) return false;
  throw new Error(`Expected boolean value, got "${value}".`);
}

function archivedWhere(value: boolean): Prisma.TaskWhereInput {
  const now = new Date();
  return value
    ? { archivedAt: { not: null, lte: now } }
    : { OR: [{ archivedAt: null }, { archivedAt: { gt: now } }] };
}

function openTaskWhere(): Prisma.TaskWhereInput {
  return {
    closedAt: null,
    status: { category: { notIn: ["done", "cancelled"] } },
  };
}

function maybeNegate(where: Prisma.TaskWhereInput, operator: QueryOperator) {
  return isNegated(operator) ? { NOT: where } satisfies Prisma.TaskWhereInput : where;
}

function applyCollectionMatch(where: Prisma.TaskWhereInput, operator: QueryOperator) {
  if (!["=", "!=", "in", "not in"].includes(operator)) {
    throw new Error(`Operator "${operator}" is not supported for this field.`);
  }
  return maybeNegate(where, operator);
}

function userFieldWhere(field: "assigneeId" | "creatorId", ids: Array<string | null>, operator: QueryOperator): Prisma.TaskWhereInput {
  const realIds = ids.filter((id): id is string => id !== null);
  const includeNull = ids.includes(null);
  const positive: Prisma.TaskWhereInput = realIds.length && includeNull
    ? { OR: [{ [field]: null }, { [field]: { in: realIds } }] }
    : includeNull
      ? { [field]: null }
      : { [field]: { in: realIds } };
  return applyCollectionMatch(positive, operator);
}

function sprintWhere(ids: Array<string | null>, operator: QueryOperator): Prisma.TaskWhereInput {
  const realIds = ids.filter((id): id is string => id !== null);
  const includeNull = ids.includes(null);
  const positive: Prisma.TaskWhereInput = realIds.length && includeNull
    ? { OR: [{ sprintId: null }, { sprintId: { in: realIds } }] }
    : includeNull
      ? { sprintId: null }
      : { sprintId: { in: realIds } };
  return applyCollectionMatch(positive, operator);
}

function dateWhere(field: "dueDate" | "createdAt" | "updatedAt" | "closedAt", operator: QueryOperator, rawValue: string): Prisma.TaskWhereInput {
  if (["in", "not in", "contains", "~"].includes(operator)) {
    throw new Error(`Operator "${operator}" is not supported for date fields.`);
  }

  if (operator === "=" || operator === "!=") {
    const range = {
      [field]: {
        ...(field === "closedAt" ? { not: null } : {}),
        gte: resolveDate(rawValue, "start"),
        lte: resolveDate(rawValue, "end"),
      },
    } satisfies Prisma.TaskWhereInput;
    return maybeNegate(range, operator);
  }

  const boundary = operator === "<" || operator === "<=" ? "end" : "start";
  const date = resolveDate(rawValue, boundary);
  const prismaOperator = operator === ">" ? "gt" : operator === ">=" ? "gte" : operator === "<" ? "lt" : "lte";
  return {
    [field]: {
      ...(field === "closedAt" ? { not: null } : {}),
      [prismaOperator]: date,
    },
  } satisfies Prisma.TaskWhereInput;
}

function textWhere(operator: QueryOperator, rawValue: string): Prisma.TaskWhereInput {
  const value = stripQuotes(rawValue);
  if (!["=", "!=", "contains", "~"].includes(operator)) {
    throw new Error(`Operator "${operator}" is not supported for text search.`);
  }

  const positive = operator === "=" || operator === "!="
    ? { title: { equals: value, mode: "insensitive" as const } }
    : {
        OR: [
          { title: { contains: value, mode: "insensitive" as const } },
          { body: { contains: value, mode: "insensitive" as const } },
        ],
      };
  return maybeNegate(positive, operator);
}

function taskNumberWhere(operator: QueryOperator, rawValue: string): Prisma.TaskWhereInput {
  if (!["=", "!="].includes(operator)) {
    throw new Error(`Operator "${operator}" is not supported for task keys.`);
  }
  const value = stripQuotes(rawValue);
  const match = value.match(/(\d+)$/);
  if (!match) {
    throw new Error(`Task key "${value}" must end with a task number.`);
  }
  return maybeNegate({ taskNumber: Number(match[1]) }, operator);
}

function clauseToWhere(
  clause: string,
  dictionary: DashboardQueryDictionary
): { where: Prisma.TaskWhereInput; field: QueryField } {
  const parsed = parseClause(clause);
  const values = expectsList(parsed.operator) ? splitValueList(parsed.rawValue) : [stripQuotes(parsed.rawValue)];

  if (values.length === 0) {
    throw new Error(`Query clause "${clause}" has no values.`);
  }

  switch (parsed.field) {
    case "status": {
      const ids = values.map((value) => findByNameOrId(dictionary.statuses, value, "status").id);
      return { field: parsed.field, where: applyCollectionMatch({ statusId: { in: ids } }, parsed.operator) };
    }
    case "statusCategory": {
      const categories = values.map((value) => {
        const token = normalizeToken(value);
        if (!statusCategories.includes(token as StatusCategory)) throw new Error(`Unknown status category "${value}".`);
        return token as StatusCategory;
      });
      return { field: parsed.field, where: applyCollectionMatch({ status: { category: { in: categories } } }, parsed.operator) };
    }
    case "priority": {
      const priorities = values.map((value) => {
        const token = normalizeToken(value);
        if (!taskPriorities.includes(token as TaskPriority)) throw new Error(`Unknown priority "${value}".`);
        return token as TaskPriority;
      });
      return { field: parsed.field, where: applyCollectionMatch({ priority: { in: priorities } }, parsed.operator) };
    }
    case "assignee": {
      return {
        field: parsed.field,
        where: userFieldWhere("assigneeId", values.map((value) => resolveUserId(dictionary.users, dictionary.currentUserId, value)), parsed.operator),
      };
    }
    case "creator": {
      return {
        field: parsed.field,
        where: userFieldWhere("creatorId", values.map((value) => resolveUserId(dictionary.users, dictionary.currentUserId, value)), parsed.operator),
      };
    }
    case "participant": {
      const ids = values.map((value) => resolveUserId(dictionary.users, dictionary.currentUserId, value)).filter((id): id is string => id !== null);
      return { field: parsed.field, where: applyCollectionMatch({ participants: { some: { userId: { in: ids } } } }, parsed.operator) };
    }
    case "tag": {
      const ids = values.map((value) => findByNameOrId(dictionary.tags, value, "tag").id);
      return { field: parsed.field, where: applyCollectionMatch({ tags: { some: { tagId: { in: ids } } } }, parsed.operator) };
    }
    case "sprint": {
      return { field: parsed.field, where: sprintWhere(values.map((value) => resolveSprintId(dictionary.sprints, value)), parsed.operator) };
    }
    case "dueDate":
    case "createdAt":
    case "updatedAt":
    case "closedAt": {
      return { field: parsed.field, where: dateWhere(parsed.field, parsed.operator, values[0]) };
    }
    case "archived": {
      if (!["=", "!="].includes(parsed.operator)) throw new Error("Archived supports only = and != operators.");
      const value = parseBoolean(values[0]);
      return { field: parsed.field, where: archivedWhere(parsed.operator === "!=" ? !value : value) };
    }
    case "overdue": {
      if (!["=", "!="].includes(parsed.operator)) throw new Error("Overdue supports only = and != operators.");
      const overdue = {
        dueDate: { lt: startOfDay(new Date()) },
        ...openTaskWhere(),
      } satisfies Prisma.TaskWhereInput;
      const value = parseBoolean(values[0]);
      return { field: parsed.field, where: value === (parsed.operator === "=") ? overdue : { NOT: overdue } };
    }
    case "text": {
      return { field: parsed.field, where: textWhere(parsed.operator, parsed.rawValue) };
    }
    case "taskNumber": {
      return { field: parsed.field, where: taskNumberWhere(parsed.operator, parsed.rawValue) };
    }
  }
}

export function buildTaskWhereFromDashboardQuery(
  projectId: string,
  query: string,
  dictionary: DashboardQueryDictionary
): DashboardQueryResult {
  const clauses = splitOnTopLevelAnd(query.trim());
  const parsedClauses = clauses.map((clause) => clauseToWhere(clause, dictionary));
  const hasArchivedClause = parsedClauses.some((clause) => clause.field === "archived");
  const and: Prisma.TaskWhereInput[] = [
    { projectId },
    ...(hasArchivedClause ? [] : [archivedWhere(false)]),
    ...parsedClauses.map((clause) => clause.where),
  ];

  return {
    where: { AND: and },
    clauses,
  };
}

export function dashboardQueryHelp() {
  return [
    "status = Done",
    "priority in (high, urgent)",
    "assignee = me()",
    "tag in (Backend, UI)",
    "due <= today()",
    "overdue = true",
    "sprint = active()",
    "text ~ \"login bug\"",
  ];
}
