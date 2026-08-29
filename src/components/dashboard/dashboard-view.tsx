"use client";

import { useEffect, useMemo, useState } from "react";
import type { inferRouterOutputs } from "@trpc/server";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { trpc } from "@/lib/trpc-client";
import type { AppRouter } from "@/server/routers/_app";
import type { TaskFilterTagOption } from "@/lib/types";

type RouterOutputs = inferRouterOutputs<AppRouter>;
type Dashboard = RouterOutputs["dashboard"]["listDashboards"][number];
type DashboardWidget = Dashboard["widgets"][number];
type DashboardDataWidget = RouterOutputs["dashboard"]["getDashboardData"]["widgets"][number];
type Person = RouterOutputs["project"]["people"][number];

type Visibility = "public" | "restricted";
type WidgetType = "metric" | "pie" | "bar" | "table" | "burndown";
type WidgetGroupBy = "status" | "priority" | "assignee" | "tag" | "sprint" | "dueMonth";
type WidgetMetric = "count" | "overdue" | "completed" | "unassigned";

type BurndownDay = { date: string; remaining: number; ideal: number };

interface DashboardViewProps {
  projectId: string;
  statuses: Array<{ id: string; name: string; color: string; category?: string }>;
  tags: TaskFilterTagOption[];
  projectSettings?: Record<string, unknown> | null;
}

interface DashboardDraft {
  name: string;
  description: string;
  visibility: Visibility;
  shareUserIds: string[];
}

interface FilterDraft extends DashboardDraft {
  query: string;
}

interface WidgetDraft {
  title: string;
  type: WidgetType;
  groupBy: WidgetGroupBy;
  metric: WidgetMetric;
  savedFilterId: string;
  query: string;
  /** Burndown widgets only: selected sprint id ("" = active sprint) */
  sprintId: string;
  width: 1 | 2;
}

const emptyDashboardDraft: DashboardDraft = {
  name: "Team dashboard",
  description: "",
  visibility: "public",
  shareUserIds: [],
};

const emptyFilterDraft: FilterDraft = {
  name: "Open high-priority work",
  description: "",
  visibility: "public",
  shareUserIds: [],
  query: "priority in (high, urgent) AND archived = false",
};

const emptyWidgetDraft: WidgetDraft = {
  title: "Open work by status",
  type: "bar",
  groupBy: "status",
  metric: "count",
  savedFilterId: "",
  query: "",
  sprintId: "",
  width: 2,
};

const metricLabels: Record<WidgetMetric, string> = {
  count: "Task count",
  overdue: "Overdue tasks",
  completed: "Completed tasks",
  unassigned: "Unassigned tasks",
};

const groupByLabels: Record<WidgetGroupBy, string> = {
  status: "Status",
  priority: "Priority",
  assignee: "Assignee",
  tag: "Tag",
  sprint: "Sprint",
  dueMonth: "Due month",
};

const widgetTypeLabels: Record<WidgetType, string> = {
  metric: "Metric",
  pie: "Pie chart",
  bar: "Bar chart",
  table: "Task table",
  burndown: "Burndown chart",
};

function userLabel(person: Person) {
  return person.name?.trim() || person.email;
}

function resetWidgetDraftForType(type: WidgetType, current: WidgetDraft): WidgetDraft {
  if (type === "metric") return { ...current, type, title: current.title || "Task count", width: 1 };
  if (type === "table") return { ...current, type, title: current.title || "Matching tasks", width: 2 };
  if (type === "burndown") return { ...current, type, title: current.title || "Sprint burndown", width: 2 };
  return { ...current, type, title: current.title || "Chart", width: 2 };
}

function getShareUserIds(resource: { shares: Array<{ userId: string }> }) {
  return resource.shares.map((share) => share.userId);
}

function seriesFromWidget(widget: DashboardDataWidget) {
  return "series" in widget && Array.isArray(widget.series) ? widget.series : [];
}

function tasksFromWidget(widget: DashboardDataWidget) {
  return "tasks" in widget && Array.isArray(widget.tasks) ? widget.tasks : [];
}

function daysFromWidget(widget: DashboardDataWidget) {
  return "days" in widget && Array.isArray(widget.days) ? (widget.days as BurndownDay[]) : [];
}

function formatDate(value: string | Date) {
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function VisibilityBadge({ visibility }: { visibility: Visibility | string }) {
  return <Badge variant={visibility === "restricted" ? "outline" : "default"}>{visibility === "restricted" ? "Restricted" : "Public"}</Badge>;
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <label className="text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--color-text-muted)" }}>{children}</label>;
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border p-4" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)", boxShadow: "var(--shadow-sm)" }}>
      <h3 className="text-sm font-semibold" style={{ color: "var(--color-text)" }}>{title}</h3>
      <div className="mt-3 space-y-3">{children}</div>
    </section>
  );
}

function UserChecklist({
  people,
  value,
  onChange,
  disabled,
}: {
  people: Person[];
  value: string[];
  onChange: (value: string[]) => void;
  disabled?: boolean;
}) {
  if (disabled) {
    return <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>Public items are visible to everyone who can access this project.</p>;
  }

  return (
    <div className="max-h-44 space-y-1 overflow-y-auto rounded-xl border p-2" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-bg-muted)" }}>
      {people.length === 0 ? (
        <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>No project members found.</p>
      ) : people.map((person) => {
        const checked = value.includes(person.id);
        return (
          <label key={person.id} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-[var(--color-surface-hover)]" style={{ color: "var(--color-text-secondary)" }}>
            <input
              type="checkbox"
              checked={checked}
              onChange={() => onChange(checked ? value.filter((id) => id !== person.id) : [...value, person.id])}
            />
            <span className="min-w-0 truncate">{userLabel(person)}</span>
          </label>
        );
      })}
    </div>
  );
}

function QueryHints({ examples, statuses, tags }: { examples: string[]; statuses: DashboardViewProps["statuses"]; tags: TaskFilterTagOption[] }) {
  return (
    <div className="rounded-xl border p-3 text-xs" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-bg-muted)", color: "var(--color-text-muted)" }}>
      <div className="font-semibold" style={{ color: "var(--color-text-secondary)" }}>JQL-style examples</div>
      <div className="mt-2 flex flex-wrap gap-2">
        {examples.slice(0, 6).map((example) => <code key={example} className="rounded-lg bg-[var(--color-surface)] px-2 py-1">{example}</code>)}
      </div>
      <div className="mt-3 grid gap-2 md:grid-cols-2">
        <div>Statuses: {statuses.slice(0, 5).map((status) => status.name).join(", ") || "none"}</div>
        <div>Tags: {tags.slice(0, 5).map((tag) => tag.name).join(", ") || "none"}</div>
      </div>
    </div>
  );
}

function PieChart({ series }: { series: Array<{ key: string; label: string; value: number; color?: string | null }> }) {
  const total = series.reduce((sum, item) => sum + item.value, 0);
  let offset = 0;

  if (total === 0) {
    return <div className="grid h-48 place-items-center text-sm" style={{ color: "var(--color-text-muted)" }}>No data</div>;
  }

  function point(angle: number) {
    const radians = (angle - 90) * Math.PI / 180;
    return { x: 50 + 40 * Math.cos(radians), y: 50 + 40 * Math.sin(radians) };
  }

  return (
    <div className="grid gap-4 md:grid-cols-[180px_minmax(0,1fr)] md:items-center">
      <svg viewBox="0 0 100 100" className="h-44 w-44">
        {series.map((item) => {
          const start = offset / total * 360;
          offset += item.value;
          const end = offset / total * 360;
          if (item.value === total) {
            return <circle key={item.key} cx="50" cy="50" r="40" fill={item.color ?? "var(--color-accent)"} />;
          }
          const startPoint = point(start);
          const endPoint = point(end);
          const largeArc = end - start > 180 ? 1 : 0;
          const path = `M 50 50 L ${startPoint.x} ${startPoint.y} A 40 40 0 ${largeArc} 1 ${endPoint.x} ${endPoint.y} Z`;
          return <path key={item.key} d={path} fill={item.color ?? "var(--color-accent)"} />;
        })}
      </svg>
      <SeriesLegend series={series} />
    </div>
  );
}

function SeriesLegend({ series }: { series: Array<{ key: string; label: string; value: number; color?: string | null }> }) {
  const total = series.reduce((sum, item) => sum + item.value, 0);
  return (
    <div className="space-y-2">
      {series.map((item) => (
        <div key={item.key} className="flex items-center justify-between gap-3 text-xs">
          <div className="flex min-w-0 items-center gap-2">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: item.color ?? "var(--color-accent)" }} />
            <span className="truncate" style={{ color: "var(--color-text-secondary)" }}>{item.label}</span>
          </div>
          <span className="font-semibold" style={{ color: "var(--color-text)" }}>{item.value} ({Math.round(item.value / Math.max(1, total) * 100)}%)</span>
        </div>
      ))}
    </div>
  );
}

function BarChart({ series }: { series: Array<{ key: string; label: string; value: number; color?: string | null }> }) {
  const max = Math.max(1, ...series.map((item) => item.value));
  if (series.length === 0) {
    return <div className="grid h-48 place-items-center text-sm" style={{ color: "var(--color-text-muted)" }}>No data</div>;
  }

  return (
    <div className="space-y-3">
      {series.map((item) => (
        <div key={item.key} className="grid grid-cols-[minmax(80px,160px)_1fr_auto] items-center gap-3 text-xs">
          <span className="truncate" style={{ color: "var(--color-text-secondary)" }}>{item.label}</span>
          <div className="h-3 overflow-hidden rounded-full" style={{ backgroundColor: "var(--color-bg-muted)" }}>
            <div className="h-full rounded-full" style={{ width: `${Math.max(4, item.value / max * 100)}%`, backgroundColor: item.color ?? "var(--color-accent)" }} />
          </div>
          <span className="font-semibold" style={{ color: "var(--color-text)" }}>{item.value}</span>
        </div>
      ))}
    </div>
  );
}

function BurndownChart({ days }: { days: BurndownDay[] }) {
  if (days.length === 0) {
    return <div className="grid h-48 place-items-center text-sm" style={{ color: "var(--color-text-muted)" }}>No data</div>;
  }

  const width = 640;
  const height = 240;
  const padding = { top: 14, right: 14, bottom: 30, left: 44 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const maxValue = Math.max(1, ...days.map((day) => Math.max(day.remaining, day.ideal)));
  const xFor = (index: number) =>
    days.length === 1 ? padding.left : padding.left + (index / (days.length - 1)) * chartWidth;
  const yFor = (value: number) => padding.top + (1 - value / maxValue) * chartHeight;
  const toPoints = (pick: (day: BurndownDay) => number) =>
    days.map((day, index) => `${xFor(index)},${yFor(pick(day))}`).join(" ");

  const lastDay = days[days.length - 1];
  const yTicks = [0, Math.round(maxValue / 2), maxValue];
  const xTickIndexes = days.length >= 3 ? [0, Math.floor((days.length - 1) / 2), days.length - 1] : days.map((_, index) => index);

  return (
    <div className="space-y-2">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-56 w-full"
        role="img"
        aria-label={`Burndown chart of ${days.length} day${days.length === 1 ? "" : "s"}: ${lastDay.remaining} task${lastDay.remaining === 1 ? "" : "s"} remaining`}
      >
        {yTicks.map((tick) => (
          <g key={`y-${tick}`}>
            <line
              x1={padding.left}
              x2={width - padding.right}
              y1={yFor(tick)}
              y2={yFor(tick)}
              stroke="var(--color-border)"
              strokeWidth={1}
            />
            <text x={padding.left - 8} y={yFor(tick)} fontSize={11} textAnchor="end" dominantBaseline="middle" fill="var(--color-text-muted)">
              {tick}
            </text>
          </g>
        ))}
        {xTickIndexes.map((index) => (
          <text
            key={`x-${index}`}
            x={xFor(index)}
            y={height - 10}
            fontSize={11}
            textAnchor={index === 0 ? "start" : index === days.length - 1 ? "end" : "middle"}
            fill="var(--color-text-muted)"
          >
            {formatDate(days[index].date)}
          </text>
        ))}
        <polyline points={toPoints((day) => day.ideal)} fill="none" stroke="var(--color-text-muted)" strokeWidth={1.5} strokeDasharray="6 5" strokeLinecap="round" strokeLinejoin="round" />
        <polyline points={toPoints((day) => day.remaining)} fill="none" stroke="var(--color-accent)" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
        {days.map((day, index) => (
          <circle key={day.date} cx={xFor(index)} cy={yFor(day.remaining)} r={2.5} fill="var(--color-accent)" />
        ))}
      </svg>
      <div className="flex flex-wrap gap-4 text-xs" style={{ color: "var(--color-text-secondary)" }}>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-0.5 w-4 rounded-full" style={{ backgroundColor: "var(--color-accent)" }} />
          Remaining
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-0.5 w-4 rounded-full" style={{ backgroundColor: "var(--color-text-muted)" }} />
          Ideal
        </span>
      </div>
    </div>
  );
}

function TableWidget({ widget }: { widget: DashboardDataWidget }) {
  const tasks = tasksFromWidget(widget);
  if (tasks.length === 0) {
    return <div className="rounded-xl border p-4 text-sm" style={{ borderColor: "var(--color-border)", color: "var(--color-text-muted)" }}>No matching tasks.</div>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-xs uppercase" style={{ borderColor: "var(--color-border)", color: "var(--color-text-muted)" }}>
            <th className="py-2 pr-3">Key</th>
            <th className="py-2 pr-3">Title</th>
            <th className="py-2 pr-3">Status</th>
            <th className="py-2 pr-3">Assignee</th>
            <th className="py-2">Due</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => (
            <tr key={task.id} className="border-b last:border-0" style={{ borderColor: "var(--color-border)" }}>
              <td className="whitespace-nowrap py-2 pr-3 text-xs font-semibold" style={{ color: "var(--color-accent)" }}>{task.project.key}-{task.taskNumber}</td>
              <td className="min-w-52 py-2 pr-3" style={{ color: "var(--color-text)" }}>{task.title}</td>
              <td className="py-2 pr-3"><span className="rounded-full px-2 py-0.5 text-xs" style={{ backgroundColor: task.status.color, color: "var(--color-on-accent)" }}>{task.status.name}</span></td>
              <td className="py-2 pr-3" style={{ color: "var(--color-text-muted)" }}>{task.assignee?.name ?? task.assignee?.email ?? "Unassigned"}</td>
              <td className="whitespace-nowrap py-2" style={{ color: "var(--color-text-muted)" }}>{formatDate(task.dueDate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function WidgetCard({ widget, config, onEdit, onDelete }: { widget: DashboardDataWidget; config?: DashboardWidget; onEdit: () => void; onDelete: () => void }) {
  const series = seriesFromWidget(widget);
  const days = daysFromWidget(widget);
  const width = config?.width === 2 || widget.type === "table" || widget.type === "burndown" ? "xl:col-span-2" : "";

  return (
    <section className={`rounded-2xl border p-4 ${width}`} style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)", boxShadow: "var(--shadow-sm)" }}>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="font-semibold" style={{ color: "var(--color-text)" }}>{widget.title}</h3>
            <Badge variant="outline">{widgetTypeLabels[widget.type as WidgetType] ?? widget.type}</Badge>
          </div>
          <p className="mt-1 text-xs" style={{ color: "var(--color-text-muted)" }}>
            {widget.type === "burndown"
              ? "sprintName" in widget && widget.sprintName
                ? `Sprint: ${widget.sprintName}`
                : "Active sprint"
              : widget.savedFilterId
                ? "Saved filter"
                : widget.query
                  ? widget.query
                  : "All active project tasks"}
          </p>
        </div>
        <div className="flex gap-2">
          <Button type="button" size="sm" variant="outline" onClick={onEdit}>Edit</Button>
          <Button type="button" size="sm" variant="ghost" onClick={onDelete}>Remove</Button>
        </div>
      </div>

      {widget.error ? (
        <div className="rounded-xl border p-3 text-sm" style={{ borderColor: "color-mix(in srgb, var(--color-danger) 35%, var(--color-border))", backgroundColor: "color-mix(in srgb, var(--color-danger) 10%, transparent)", color: "var(--color-danger)" }}>{widget.error}</div>
      ) : widget.type === "burndown" ? (
        <BurndownChart days={days} />
      ) : widget.type === "metric" ? (
        <div>
          <div className="text-5xl font-semibold" style={{ color: "var(--color-text)" }}>{widget.total}</div>
          <p className="mt-2 text-sm" style={{ color: "var(--color-text-muted)" }}>{metricLabels[widget.metric as WidgetMetric] ?? "Task count"}</p>
        </div>
      ) : widget.type === "pie" ? (
        <PieChart series={series} />
      ) : widget.type === "bar" ? (
        <BarChart series={series} />
      ) : (
        <TableWidget widget={widget} />
      )}
    </section>
  );
}

export function DashboardView({ projectId, statuses, tags }: DashboardViewProps) {
  const utils = trpc.useUtils();
  const [selectedDashboardId, setSelectedDashboardId] = useState<string | null>(null);
  const [isCreatingDashboard, setIsCreatingDashboard] = useState(false);
  const [selectedFilterId, setSelectedFilterId] = useState<string>("");
  const [editingWidgetId, setEditingWidgetId] = useState<string>("");
  const [dashboardDraft, setDashboardDraft] = useState<DashboardDraft>(emptyDashboardDraft);
  const [filterDraft, setFilterDraft] = useState<FilterDraft>(emptyFilterDraft);
  const [widgetDraft, setWidgetDraft] = useState<WidgetDraft>(emptyWidgetDraft);
  const [actionError, setActionError] = useState<string | null>(null);

  const { data: dashboards = [], isLoading: dashboardsLoading } = trpc.dashboard.listDashboards.useQuery({ projectId });
  const { data: savedFilters = [] } = trpc.dashboard.listSavedFilters.useQuery({ projectId });
  const { data: people = [] } = trpc.project.people.useQuery({ projectId });
  const { data: sprints = [] } = trpc.sprint.list.useQuery({ projectId });
  const { data: queryExamples = [] } = trpc.dashboard.queryHelp.useQuery();

  const selectedDashboard = useMemo(
    () => isCreatingDashboard ? null : dashboards.find((dashboard) => dashboard.id === selectedDashboardId) ?? dashboards[0] ?? null,
    [dashboards, isCreatingDashboard, selectedDashboardId]
  );

  // NOTE(pagination): this view never queries `task.list` directly — widget task
  // data (metric/pie/bar/table) is fetched server-side by
  // `dashboard.getDashboardData`, which caps table widgets at a small page
  // (take: 12). Real pagination for dashboard widget tables is a follow-up:
  // TODO(pagination): range/offset-based widget task tables (server-side), see
  // follow-up bead "dashboard widget table pagination".
  const { data: dashboardData, isLoading: dataLoading } = trpc.dashboard.getDashboardData.useQuery(
    { dashboardId: selectedDashboard?.id ?? "" },
    { enabled: !!selectedDashboard?.id }
  );

  const selectedFilter = useMemo(
    () => savedFilters.find((filter) => filter.id === selectedFilterId) ?? null,
    [savedFilters, selectedFilterId]
  );

  const editingWidget = useMemo(
    () => selectedDashboard?.widgets.find((widget) => widget.id === editingWidgetId) ?? null,
    [editingWidgetId, selectedDashboard]
  );

  useEffect(() => {
    if (dashboardsLoading) return;
    if (dashboards.length === 0) {
      setSelectedDashboardId(null);
      setIsCreatingDashboard(true);
      return;
    }
    if (isCreatingDashboard) return;
    if (!selectedDashboardId || !dashboards.some((dashboard) => dashboard.id === selectedDashboardId)) {
      setSelectedDashboardId(dashboards[0].id);
    }
  }, [dashboards, dashboardsLoading, isCreatingDashboard, selectedDashboardId]);

  useEffect(() => {
    if (!selectedDashboard) {
      setDashboardDraft(emptyDashboardDraft);
      return;
    }
    setDashboardDraft({
      name: selectedDashboard.name,
      description: selectedDashboard.description ?? "",
      visibility: selectedDashboard.visibility as Visibility,
      shareUserIds: getShareUserIds(selectedDashboard),
    });
  }, [selectedDashboard]);

  useEffect(() => {
    if (!selectedFilter) {
      setFilterDraft(emptyFilterDraft);
      return;
    }
    setFilterDraft({
      name: selectedFilter.name,
      description: selectedFilter.description ?? "",
      query: selectedFilter.query,
      visibility: selectedFilter.visibility as Visibility,
      shareUserIds: getShareUserIds(selectedFilter),
    });
  }, [selectedFilter]);

  useEffect(() => {
    if (!editingWidget) {
      setWidgetDraft(emptyWidgetDraft);
      return;
    }
    setWidgetDraft({
      title: editingWidget.title,
      type: editingWidget.type as WidgetType,
      groupBy: (editingWidget.groupBy ?? "status") as WidgetGroupBy,
      metric: editingWidget.metric as WidgetMetric,
      savedFilterId: editingWidget.savedFilterId ?? "",
      query: editingWidget.query ?? "",
      // Burndown widgets store their chosen sprint id in the query column.
      sprintId: editingWidget.type === "burndown" ? editingWidget.query ?? "" : "",
      width: editingWidget.width === 2 ? 2 : 1,
    });
  }, [editingWidget]);

  function invalidateDashboardData(dashboardId = selectedDashboard?.id) {
    utils.dashboard.listDashboards.invalidate({ projectId });
    utils.dashboard.listSavedFilters.invalidate({ projectId });
    if (dashboardId) utils.dashboard.getDashboardData.invalidate({ dashboardId });
  }

  const createDashboard = trpc.dashboard.createDashboard.useMutation({
    onMutate: () => setActionError(null),
    onSuccess: (dashboard) => {
      setIsCreatingDashboard(false);
      setSelectedDashboardId(dashboard.id);
      invalidateDashboardData(dashboard.id);
    },
    onError: (error) => setActionError(error.message),
  });

  const updateDashboard = trpc.dashboard.updateDashboard.useMutation({
    onMutate: () => setActionError(null),
    onSuccess: () => invalidateDashboardData(),
    onError: (error) => setActionError(error.message),
  });

  const deleteDashboard = trpc.dashboard.deleteDashboard.useMutation({
    onMutate: () => setActionError(null),
    onSuccess: () => {
      setSelectedDashboardId(null);
      setIsCreatingDashboard(false);
      invalidateDashboardData();
    },
    onError: (error) => setActionError(error.message),
  });

  const createSavedFilter = trpc.dashboard.createSavedFilter.useMutation({
    onMutate: () => setActionError(null),
    onSuccess: (filter) => {
      setSelectedFilterId(filter.id);
      invalidateDashboardData();
    },
    onError: (error) => setActionError(error.message),
  });

  const updateSavedFilter = trpc.dashboard.updateSavedFilter.useMutation({
    onMutate: () => setActionError(null),
    onSuccess: () => invalidateDashboardData(),
    onError: (error) => setActionError(error.message),
  });

  const deleteSavedFilter = trpc.dashboard.deleteSavedFilter.useMutation({
    onMutate: () => setActionError(null),
    onSuccess: () => {
      setSelectedFilterId("");
      invalidateDashboardData();
    },
    onError: (error) => setActionError(error.message),
  });

  const addWidget = trpc.dashboard.addWidget.useMutation({
    onMutate: () => setActionError(null),
    onSuccess: () => {
      setEditingWidgetId("");
      invalidateDashboardData();
    },
    onError: (error) => setActionError(error.message),
  });

  const updateWidget = trpc.dashboard.updateWidget.useMutation({
    onMutate: () => setActionError(null),
    onSuccess: () => {
      setEditingWidgetId("");
      invalidateDashboardData();
    },
    onError: (error) => setActionError(error.message),
  });

  const deleteWidget = trpc.dashboard.deleteWidget.useMutation({
    onMutate: () => setActionError(null),
    onSuccess: () => invalidateDashboardData(),
    onError: (error) => setActionError(error.message),
  });

  function submitDashboard(event: React.FormEvent) {
    event.preventDefault();
    const payload = {
      name: dashboardDraft.name.trim(),
      description: dashboardDraft.description.trim() || null,
      visibility: dashboardDraft.visibility,
      shareUserIds: dashboardDraft.visibility === "restricted" ? dashboardDraft.shareUserIds : [],
    };
    if (!payload.name) return;
    if (selectedDashboard) {
      updateDashboard.mutate({ dashboardId: selectedDashboard.id, ...payload });
    } else {
      createDashboard.mutate({ projectId, ...payload });
    }
  }

  function submitFilter(event: React.FormEvent) {
    event.preventDefault();
    const payload = {
      name: filterDraft.name.trim(),
      description: filterDraft.description.trim() || null,
      query: filterDraft.query.trim(),
      visibility: filterDraft.visibility,
      shareUserIds: filterDraft.visibility === "restricted" ? filterDraft.shareUserIds : [],
    };
    if (!payload.name) return;
    if (selectedFilter) {
      updateSavedFilter.mutate({ filterId: selectedFilter.id, ...payload });
    } else {
      createSavedFilter.mutate({ projectId, ...payload });
    }
  }

  function submitWidget(event: React.FormEvent) {
    event.preventDefault();
    if (!selectedDashboard) return;
    const payload = {
      title: widgetDraft.title.trim(),
      type: widgetDraft.type,
      groupBy: widgetDraft.type === "bar" || widgetDraft.type === "pie" ? widgetDraft.groupBy : null,
      metric: widgetDraft.metric,
      savedFilterId: widgetDraft.savedFilterId || null,
      // Burndown widgets keep the chosen sprint id in the query column;
      // empty means "use the project's active sprint".
      query: widgetDraft.type === "burndown"
        ? widgetDraft.sprintId || null
        : widgetDraft.savedFilterId ? null : widgetDraft.query.trim() || null,
      width: widgetDraft.width,
    };
    if (!payload.title) return;
    if (editingWidget) {
      updateWidget.mutate({ widgetId: editingWidget.id, ...payload });
    } else {
      addWidget.mutate({ dashboardId: selectedDashboard.id, ...payload });
    }
  }

  const widgetDataById = new Map((dashboardData?.widgets ?? []).map((widget) => [widget.id, widget]));
  const isBusy = createDashboard.isPending || updateDashboard.isPending || createSavedFilter.isPending || updateSavedFilter.isPending || addWidget.isPending || updateWidget.isPending;

  return (
    <div className="space-y-6 p-4 lg:p-6">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-xl font-semibold" style={{ color: "var(--color-text)" }}>Custom dashboards</h2>
            {selectedDashboard && <VisibilityBadge visibility={selectedDashboard.visibility} />}
          </div>
          <p className="mt-1 max-w-3xl text-sm" style={{ color: "var(--color-text-muted)" }}>
            Build Jira-style dashboards from saved filters, JQL-like task queries, and chart widgets. Public dashboards are visible to project members; restricted dashboards require explicit whitelisting.
          </p>
        </div>

        <div className="flex min-w-72 flex-col gap-2 sm:flex-row sm:items-center">
          <Select
            value={selectedDashboard?.id ?? ""}
            onChange={(event) => {
              setIsCreatingDashboard(false);
              setSelectedDashboardId(event.target.value || null);
            }}
            disabled={dashboards.length === 0}
          >
            {dashboards.length === 0 ? <option value="">No dashboards yet</option> : dashboards.map((dashboard) => <option key={dashboard.id} value={dashboard.id}>{dashboard.name}</option>)}
          </Select>
          <Button type="button" variant="outline" onClick={() => { setIsCreatingDashboard(true); setSelectedDashboardId(null); setDashboardDraft(emptyDashboardDraft); }}>New dashboard</Button>
        </div>
      </div>

      {actionError && (
        <div className="rounded-xl border px-3 py-2 text-sm" style={{ borderColor: "color-mix(in srgb, var(--color-danger) 35%, var(--color-border))", backgroundColor: "color-mix(in srgb, var(--color-danger) 10%, transparent)", color: "var(--color-danger)" }}>{actionError}</div>
      )}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <main className="space-y-4">
          {dashboardsLoading ? (
            <div className="rounded-2xl border p-8 text-center text-sm" style={{ borderColor: "var(--color-border)", color: "var(--color-text-muted)" }}>Loading dashboards...</div>
          ) : !selectedDashboard ? (
            <section className="rounded-3xl border p-8" style={{ borderColor: "var(--color-border)", background: "linear-gradient(135deg, color-mix(in srgb, var(--color-accent) 12%, var(--color-surface)) 0%, var(--color-surface) 60%, color-mix(in srgb, var(--color-info) 10%, var(--color-surface)) 100%)" }}>
              <h3 className="text-lg font-semibold" style={{ color: "var(--color-text)" }}>Create first dashboard</h3>
              <p className="mt-2 max-w-2xl text-sm" style={{ color: "var(--color-text-muted)" }}>Start with a public project dashboard, add saved filters, then attach metric, pie, bar, and task table widgets.</p>
            </section>
          ) : dataLoading ? (
            <div className="grid gap-4 xl:grid-cols-2">
              {Array.from({ length: 4 }).map((_, index) => <div key={index} className="h-56 animate-pulse rounded-2xl" style={{ backgroundColor: "var(--color-bg-muted)" }} />)}
            </div>
          ) : selectedDashboard.widgets.length === 0 ? (
            <section className="rounded-3xl border p-8 text-center" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)" }}>
              <h3 className="font-semibold" style={{ color: "var(--color-text)" }}>No widgets yet</h3>
              <p className="mt-2 text-sm" style={{ color: "var(--color-text-muted)" }}>Create a saved filter or use an inline query, then add a metric, pie chart, bar chart, or task table.</p>
            </section>
          ) : (
            <div className="grid gap-4 xl:grid-cols-2">
              {selectedDashboard.widgets.map((widget) => {
                const dataWidget = widgetDataById.get(widget.id);
                if (!dataWidget) return null;
                return (
                  <WidgetCard
                    key={widget.id}
                    widget={dataWidget}
                    config={widget}
                    onEdit={() => setEditingWidgetId(widget.id)}
                    onDelete={() => deleteWidget.mutate({ widgetId: widget.id })}
                  />
                );
              })}
            </div>
          )}
        </main>

        <aside className="space-y-4">
          <Panel title={selectedDashboard ? "Dashboard permissions" : "Create dashboard"}>
            <form onSubmit={submitDashboard} className="space-y-3">
              <div className="space-y-1.5">
                <FieldLabel>Name</FieldLabel>
                <Input value={dashboardDraft.name} onChange={(event) => setDashboardDraft((draft) => ({ ...draft, name: event.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <FieldLabel>Description</FieldLabel>
                <textarea
                  value={dashboardDraft.description}
                  onChange={(event) => setDashboardDraft((draft) => ({ ...draft, description: event.target.value }))}
                  rows={2}
                  className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none"
                  style={{ backgroundColor: "var(--color-surface)", borderColor: "var(--color-border)", color: "var(--color-text)" }}
                />
              </div>
              <div className="space-y-1.5">
                <FieldLabel>Visibility</FieldLabel>
                <Select value={dashboardDraft.visibility} onChange={(event) => setDashboardDraft((draft) => ({ ...draft, visibility: event.target.value as Visibility }))}>
                  <option value="public">Public to project members</option>
                  <option value="restricted">Restricted to whitelist</option>
                </Select>
              </div>
              <UserChecklist
                people={people}
                value={dashboardDraft.shareUserIds}
                onChange={(shareUserIds) => setDashboardDraft((draft) => ({ ...draft, shareUserIds }))}
                disabled={dashboardDraft.visibility === "public"}
              />
              <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={isBusy}>{selectedDashboard ? "Save dashboard" : "Create dashboard"}</Button>
                {selectedDashboard && <Button type="button" variant="ghost" onClick={() => deleteDashboard.mutate({ dashboardId: selectedDashboard.id })}>Delete</Button>}
              </div>
            </form>
          </Panel>

          <Panel title="Saved filters">
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant={selectedFilterId ? "outline" : "default"} onClick={() => setSelectedFilterId("")}>New filter</Button>
              {savedFilters.map((filter) => (
                <Button key={filter.id} type="button" size="sm" variant={selectedFilterId === filter.id ? "default" : "outline"} onClick={() => setSelectedFilterId(filter.id)}>{filter.name}</Button>
              ))}
            </div>
            <form onSubmit={submitFilter} className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <FieldLabel>Name</FieldLabel>
                  <Input value={filterDraft.name} onChange={(event) => setFilterDraft((draft) => ({ ...draft, name: event.target.value }))} />
                </div>
                <div className="space-y-1.5">
                  <FieldLabel>Visibility</FieldLabel>
                  <Select value={filterDraft.visibility} onChange={(event) => setFilterDraft((draft) => ({ ...draft, visibility: event.target.value as Visibility }))}>
                    <option value="public">Public</option>
                    <option value="restricted">Restricted</option>
                  </Select>
                </div>
              </div>
              <div className="space-y-1.5">
                <FieldLabel>Query</FieldLabel>
                <textarea
                  value={filterDraft.query}
                  onChange={(event) => setFilterDraft((draft) => ({ ...draft, query: event.target.value }))}
                  rows={3}
                  placeholder="status != Done AND assignee = me() AND due <= today()"
                  className="w-full rounded-md border px-3 py-2 font-mono text-xs focus:outline-none"
                  style={{ backgroundColor: "var(--color-surface)", borderColor: "var(--color-border)", color: "var(--color-text)" }}
                />
              </div>
              <UserChecklist
                people={people}
                value={filterDraft.shareUserIds}
                onChange={(shareUserIds) => setFilterDraft((draft) => ({ ...draft, shareUserIds }))}
                disabled={filterDraft.visibility === "public"}
              />
              <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={isBusy}>{selectedFilter ? "Save filter" : "Create filter"}</Button>
                {selectedFilter && <Button type="button" variant="ghost" onClick={() => deleteSavedFilter.mutate({ filterId: selectedFilter.id })}>Delete</Button>}
              </div>
            </form>
          </Panel>

          <Panel title={editingWidget ? "Edit widget" : "Add widget"}>
            <form onSubmit={submitWidget} className="space-y-3">
              <div className="space-y-1.5">
                <FieldLabel>Title</FieldLabel>
                <Input value={widgetDraft.title} onChange={(event) => setWidgetDraft((draft) => ({ ...draft, title: event.target.value }))} />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <FieldLabel>Type</FieldLabel>
                  <Select value={widgetDraft.type} onChange={(event) => setWidgetDraft((draft) => resetWidgetDraftForType(event.target.value as WidgetType, draft))}>
                    {Object.entries(widgetTypeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <FieldLabel>Width</FieldLabel>
                  <Select value={String(widgetDraft.width)} onChange={(event) => setWidgetDraft((draft) => ({ ...draft, width: Number(event.target.value) === 2 ? 2 : 1 }))}>
                    <option value="1">Half</option>
                    <option value="2">Full</option>
                  </Select>
                </div>
              </div>
              {widgetDraft.type === "metric" && (
                <div className="space-y-1.5">
                  <FieldLabel>Metric</FieldLabel>
                  <Select value={widgetDraft.metric} onChange={(event) => setWidgetDraft((draft) => ({ ...draft, metric: event.target.value as WidgetMetric }))}>
                    {Object.entries(metricLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </Select>
                </div>
              )}
              {(widgetDraft.type === "bar" || widgetDraft.type === "pie") && (
                <div className="space-y-1.5">
                  <FieldLabel>Group by</FieldLabel>
                  <Select value={widgetDraft.groupBy} onChange={(event) => setWidgetDraft((draft) => ({ ...draft, groupBy: event.target.value as WidgetGroupBy }))}>
                    {Object.entries(groupByLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </Select>
                </div>
              )}
              {widgetDraft.type === "burndown" && (
                <div className="space-y-1.5">
                  <FieldLabel>Sprint</FieldLabel>
                  <Select value={widgetDraft.sprintId} onChange={(event) => setWidgetDraft((draft) => ({ ...draft, sprintId: event.target.value }))}>
                    <option value="">Active sprint (automatic)</option>
                    {sprints.map((sprint) => <option key={sprint.id} value={sprint.id}>{sprint.name} ({sprint.status})</option>)}
                  </Select>
                </div>
              )}
              {widgetDraft.type !== "burndown" && (
                <div className="space-y-1.5">
                  <FieldLabel>Saved filter</FieldLabel>
                  <Select value={widgetDraft.savedFilterId} onChange={(event) => setWidgetDraft((draft) => ({ ...draft, savedFilterId: event.target.value }))}>
                    <option value="">Inline query or all active tasks</option>
                    {savedFilters.map((filter) => <option key={filter.id} value={filter.id}>{filter.name}</option>)}
                  </Select>
                </div>
              )}
              {!widgetDraft.savedFilterId && widgetDraft.type !== "burndown" && (
                <div className="space-y-1.5">
                  <FieldLabel>Inline query</FieldLabel>
                  <textarea
                    value={widgetDraft.query}
                    onChange={(event) => setWidgetDraft((draft) => ({ ...draft, query: event.target.value }))}
                    rows={2}
                    placeholder="Leave blank for all active tasks"
                    className="w-full rounded-md border px-3 py-2 font-mono text-xs focus:outline-none"
                    style={{ backgroundColor: "var(--color-surface)", borderColor: "var(--color-border)", color: "var(--color-text)" }}
                  />
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={!selectedDashboard || isBusy}>{editingWidget ? "Save widget" : "Add widget"}</Button>
                {editingWidget && <Button type="button" variant="outline" onClick={() => setEditingWidgetId("")}>Cancel edit</Button>}
              </div>
            </form>
          </Panel>

          <QueryHints examples={queryExamples} statuses={statuses} tags={tags} />
        </aside>
      </div>
    </div>
  );
}
