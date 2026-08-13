import { definePlugin, server } from "@komari-monitor/plugin-sdk";

const TRAFFIC_METRICS = ["traffic.up", "traffic.down"] as const;

type ReportKind = "daily" | "weekly" | "monthly";

type Config = {
  all_nodes?: unknown;
  nodes?: unknown;
  template?: unknown;
  daily_enabled?: unknown;
  daily_cron?: unknown;
  weekly_enabled?: unknown;
  weekly_cron?: unknown;
  monthly_enabled?: unknown;
  monthly_cron?: unknown;
};

type MetricPoint = { value: number | null };
type MetricSeries = {
  metric_key?: string;
  entity_id?: string;
  count?: number;
  points?: MetricPoint[];
};
type MetricResponse = { series?: MetricSeries[] };

type NodeInfo = { uuid: string; name?: string; weight?: number };
type TrafficUsage = { up: number; down: number; hasData: boolean };

type ReportConfig = {
  enabledKey: "daily_enabled" | "weekly_enabled" | "monthly_enabled";
  cronKey: "daily_cron" | "weekly_cron" | "monthly_cron";
  defaultEnabled: boolean;
  defaultCron: string;
};

const DEFAULT_CONFIG = {
  daily_enabled: true,
  daily_cron: "0 9 * * *",
  weekly_enabled: false,
  weekly_cron: "0 9 * * 1",
  monthly_enabled: false,
  monthly_cron: "0 9 1 * *",
};

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function normalizeCronExpression(expression: string): string {
  const trimmed = expression.trim();
  const compactEvery = trimmed.match(/^@every(\S+)$/i);
  return compactEvery ? `@every ${compactEvery[1]}` : trimmed;
}

function selectedNodeIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is string => typeof item === "string" && item.trim() !== "",
  );
}

function periodRange(
  kind: ReportKind,
  now = new Date(),
): { start: Date; end: Date } {
  const localNow = new Date(now.getTime());
  let start: Date;
  let end: Date;

  if (kind === "daily") {
    start = new Date(
      localNow.getFullYear(),
      localNow.getMonth(),
      localNow.getDate() - 1,
    );
    end = new Date(
      localNow.getFullYear(),
      localNow.getMonth(),
      localNow.getDate(),
    );
  } else if (kind === "weekly") {
    const daysSinceMonday = (localNow.getDay() + 6) % 7;
    const thisMonday = new Date(
      localNow.getFullYear(),
      localNow.getMonth(),
      localNow.getDate() - daysSinceMonday,
    );
    start = new Date(
      thisMonday.getFullYear(),
      thisMonday.getMonth(),
      thisMonday.getDate() - 7,
    );
    end = thisMonday;
  } else {
    const thisMonth = new Date(localNow.getFullYear(), localNow.getMonth(), 1);
    start = new Date(thisMonth.getFullYear(), thisMonth.getMonth() - 1, 1);
    end = thisMonth;
  }

  return { start, end };
}

function formatDate(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let amount = value;
  let unitIndex = -1;
  do {
    amount /= 1024;
    unitIndex += 1;
  } while (amount >= 1024 && unitIndex < units.length - 1);
  return `${amount.toFixed(2)} ${units[unitIndex]}`;
}

function formatTraffic(up: number, down: number): string {
  return `↑ ${formatBytes(up)} + ↓ ${formatBytes(down)} = ${formatBytes(up + down)}`;
}

function reportLabel(kind: ReportKind): string {
  if (kind === "daily") return "Daily report";
  if (kind === "weekly") return "Weekly report";
  return "Monthly report";
}

function eventName(kind: ReportKind): string {
  if (kind === "daily") return "DReport";
  if (kind === "weekly") return "WReport";
  return "MReport";
}

function eventEmoji(kind: ReportKind): string {
  if (kind === "daily") return "📊";
  if (kind === "weekly") return "📈";
  return "📅";
}

function replaceTemplate(
  template: string,
  values: Record<string, string>,
): string {
  return template.replace(
    /\{\{([a-zA-Z0-9_]+)\}\}/g,
    (placeholder, key: string) => {
      return Object.prototype.hasOwnProperty.call(values, key)
        ? values[key]
        : placeholder;
    },
  );
}

async function getNodeMap(): Promise<Map<string, NodeInfo>> {
  const nodes = await server.call<Record<string, NodeInfo>>("common:getNodes");
  return new Map(Object.entries(nodes));
}

function sortNodeIdsByWeight(
  nodeIds: string[],
  nodeMap: Map<string, NodeInfo>,
): string[] {
  return [...nodeIds].sort(
    (left, right) =>
      (nodeMap.get(left)?.weight ?? 0) - (nodeMap.get(right)?.weight ?? 0),
  );
}

async function queryTraffic(
  nodeIds: string[],
  start: Date,
  end: Date,
): Promise<Map<string, TrafficUsage>> {
  const response = await server.call<MetricResponse>("public:queryMetrics", {
    metric_keys: [...TRAFFIC_METRICS],
    entity_ids: nodeIds,
    start: start.toISOString(),
    end: new Date(end.getTime() - 1).toISOString(),
    aggregation_by_metric: {
      "traffic.up": "sum",
      "traffic.down": "sum",
    },
    max_points: 10000,
  });

  const result = new Map<string, TrafficUsage>();
  for (const series of response.series ?? []) {
    if (!series.entity_id || !series.metric_key) continue;
    const current = result.get(series.entity_id) ?? {
      up: 0,
      down: 0,
      hasData: false,
    };
    if ((series.count ?? 0) > 0) current.hasData = true;
    for (const point of series.points ?? []) {
      const value = point.value;
      if (value === null) continue;
      current.hasData = true;
      if (series.metric_key === "traffic.up") current.up += value;
      if (series.metric_key === "traffic.down") current.down += value;
    }
    result.set(series.entity_id, current);
  }
  return result;
}

async function sendReport(kind: ReportKind): Promise<void> {
  const config = await server.getConfig<Config>();
  const nodeMap = await getNodeMap();
  const nodeIds = sortNodeIdsByWeight(
    asBoolean(config.all_nodes, false)
      ? [...nodeMap.keys()]
      : selectedNodeIds(config.nodes),
    nodeMap,
  );
  if (nodeIds.length === 0) return;

  const { start, end } = periodRange(kind);
  const traffic = await queryTraffic(nodeIds, start, end);
  const lines: string[] = [];
  let totalUp = 0;
  let totalDown = 0;

  for (const uuid of nodeIds) {
    const node = nodeMap.get(uuid);
    const usage = traffic.get(uuid);
    const name = node?.name || uuid;
    if (!usage?.hasData) {
      lines.push(`• ${name}：NaN`);
      continue;
    }
    totalUp += usage.up;
    totalDown += usage.down;
    lines.push(`• ${name}：${formatTraffic(usage.up, usage.down)}`);
  }

  const message = [
    reportLabel(kind),
    `${formatDate(start)} ~ ${formatDate(end)}`,
    "",
    ...lines,
    "",
    `Total:${formatTraffic(totalUp, totalDown)}`,
  ].join("\n");
  const event = eventName(kind);
  const emoji = eventEmoji(kind);
  const time = new Date().toISOString();
  const template = asString(config.template, "").trim();
  const renderedMessage = template
    ? replaceTemplate(template, {
        period: reportLabel(kind),
        start: formatDate(start),
        end: formatDate(end),
        message,
        nodes: lines.join("\n"),
        event,
        emoji,
        time,
      })
    : message;

  await server.call("admin:sendNotification", {
    event: {
      event,
      time,
      emoji,
      ...(template ? { message: renderedMessage } : { message }),
    },
  });
}

function registerReport(
  kind: ReportKind,
  config: ReportConfig,
  savedConfig: Config,
): void {
  const expression = normalizeCronExpression(
    asString(savedConfig[config.cronKey], config.defaultCron),
  );
  server.cron(expression, async () => {
    const currentConfig = await server.getConfig<Config>();
    if (!asBoolean(currentConfig[config.enabledKey], config.defaultEnabled))
      return;
    await sendReport(kind);
  });
}

definePlugin({
  async load() {
    const savedConfig = await server.getConfig<Config>();
    registerReport(
      "daily",
      {
        enabledKey: "daily_enabled",
        cronKey: "daily_cron",
        defaultEnabled: DEFAULT_CONFIG.daily_enabled,
        defaultCron: DEFAULT_CONFIG.daily_cron,
      },
      savedConfig,
    );
    registerReport(
      "weekly",
      {
        enabledKey: "weekly_enabled",
        cronKey: "weekly_cron",
        defaultEnabled: DEFAULT_CONFIG.weekly_enabled,
        defaultCron: DEFAULT_CONFIG.weekly_cron,
      },
      savedConfig,
    );
    registerReport(
      "monthly",
      {
        enabledKey: "monthly_enabled",
        cronKey: "monthly_cron",
        defaultEnabled: DEFAULT_CONFIG.monthly_enabled,
        defaultCron: DEFAULT_CONFIG.monthly_cron,
      },
      savedConfig,
    );
  },
});
