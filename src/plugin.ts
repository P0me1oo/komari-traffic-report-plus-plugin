import { definePlugin, server } from "@komari-monitor/plugin-sdk";

const TRAFFIC_METRICS = ["traffic.up", "traffic.down"] as const;
// 峰值带宽来自速率指标：net.out.rate 为上行，net.in.rate 为下行（单位 bytes/s）
const SPEED_METRICS = ["net.out.rate", "net.in.rate"] as const;

type ReportKind = "daily" | "weekly" | "monthly";

type Config = {
  all_nodes?: unknown;
  nodes?: unknown;
  sort_order?: unknown;
  show_detail?: unknown;
  show_peak?: unknown;
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
type TrafficUsage = {
  up: number;
  down: number;
  peakUp: number;
  peakDown: number;
  hasData: boolean;
};

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

function formatRate(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}

function formatShortDate(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// 周期标题：日报只显示当天，周报显示首尾日期，月报只显示年月
function formatPeriodTitle(kind: ReportKind, start: Date, end: Date): string {
  if (kind === "daily") return formatShortDate(start);
  if (kind === "monthly") {
    const pad = (value: number): string => String(value).padStart(2, "0");
    return `${start.getFullYear()}-${pad(start.getMonth() + 1)}`;
  }
  // end 是排他边界，展示时换算成周期内最后一天
  const lastDay = new Date(end.getTime() - 24 * 60 * 60 * 1000);
  return `${formatShortDate(start)} ~ ${formatShortDate(lastDay)}`;
}

// 节点行 / 合计行的统一格式：
// 名称：总流量（↑ 上传 / ↓ 下载，峰值 ↑ x ↓ y）
function formatUsageLine(
  name: string,
  usage: TrafficUsage,
  showDetail: boolean,
  showPeak: boolean,
): string {
  const details: string[] = [];
  if (showDetail) {
    details.push(`↑ ${formatBytes(usage.up)} / ↓ ${formatBytes(usage.down)}`);
  }
  if (showPeak) {
    details.push(
      `峰值 ↑ ${formatRate(usage.peakUp)} ↓ ${formatRate(usage.peakDown)}`,
    );
  }
  const detail = details.length > 0 ? `（${details.join("，")}）` : "";
  return `${name}：${formatBytes(usage.up + usage.down)}${detail}`;
}

function reportLabel(kind: ReportKind): string {
  if (kind === "daily") return "流量日报";
  if (kind === "weekly") return "流量周报";
  return "流量月报";
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
  includeSpeed: boolean,
): Promise<Map<string, TrafficUsage>> {
  const metricKeys = [
    ...TRAFFIC_METRICS,
    ...(includeSpeed ? SPEED_METRICS : []),
  ];
  // 流量按 sum 聚合（周期总量），速率按 max 聚合（周期峰值）。
  // 原始数据窗口下服务端不做聚合，两种模式都通过逐点求和 / 取最大值得到结果。
  const aggregationByMetric: Record<string, string> = {
    "traffic.up": "sum",
    "traffic.down": "sum",
  };
  if (includeSpeed) {
    aggregationByMetric["net.out.rate"] = "max";
    aggregationByMetric["net.in.rate"] = "max";
  }

  const response = await server.call<MetricResponse>("public:queryMetrics", {
    metric_keys: metricKeys,
    entity_ids: nodeIds,
    start: start.toISOString(),
    end: new Date(end.getTime() - 1).toISOString(),
    aggregation_by_metric: aggregationByMetric,
    max_points: 10000,
  });

  const result = new Map<string, TrafficUsage>();
  for (const series of response.series ?? []) {
    if (!series.entity_id || !series.metric_key) continue;
    const current = result.get(series.entity_id) ?? {
      up: 0,
      down: 0,
      peakUp: 0,
      peakDown: 0,
      hasData: false,
    };
    // 只有流量指标能证明节点有数据；仅有速率采样的节点不算
    const isTraffic =
      series.metric_key === "traffic.up" ||
      series.metric_key === "traffic.down";
    if (isTraffic && (series.count ?? 0) > 0) current.hasData = true;
    for (const point of series.points ?? []) {
      const value = point.value;
      if (value === null) continue;
      switch (series.metric_key) {
        case "traffic.up":
          current.up += value;
          current.hasData = true;
          break;
        case "traffic.down":
          current.down += value;
          current.hasData = true;
          break;
        case "net.out.rate":
          current.peakUp = Math.max(current.peakUp, value);
          break;
        case "net.in.rate":
          current.peakDown = Math.max(current.peakDown, value);
          break;
      }
    }
    result.set(series.entity_id, current);
  }
  return result;
}

// 流量排序时的排序值：无数据的节点固定排在最后
function nodeTrafficTotal(
  traffic: Map<string, TrafficUsage>,
  uuid: string,
): number {
  const usage = traffic.get(uuid);
  return usage?.hasData ? usage.up + usage.down : -1;
}

async function sendReport(kind: ReportKind): Promise<void> {
  const config = await server.getConfig<Config>();
  const nodeMap = await getNodeMap();
  const weightOrderedIds = sortNodeIdsByWeight(
    asBoolean(config.all_nodes, false)
      ? [...nodeMap.keys()]
      : selectedNodeIds(config.nodes),
    nodeMap,
  );
  if (weightOrderedIds.length === 0) return;

  const showDetail = asBoolean(config.show_detail, true);
  const showPeak = asBoolean(config.show_peak, true);
  const sortByTraffic = asString(config.sort_order, "面板顺序").includes(
    "流量",
  );

  const { start, end } = periodRange(kind);
  const traffic = await queryTraffic(weightOrderedIds, start, end, showPeak);
  const nodeIds = sortByTraffic
    ? [...weightOrderedIds].sort(
        (left, right) =>
          nodeTrafficTotal(traffic, right) - nodeTrafficTotal(traffic, left),
      )
    : weightOrderedIds;

  const lines: string[] = [];
  let totalUp = 0;
  let totalDown = 0;
  let totalPeakUp = 0;
  let totalPeakDown = 0;

  for (const uuid of nodeIds) {
    const node = nodeMap.get(uuid);
    const usage = traffic.get(uuid);
    const name = node?.name || uuid;
    if (!usage?.hasData) {
      lines.push(`${name}：暂无数据`);
      continue;
    }
    totalUp += usage.up;
    totalDown += usage.down;
    // 合计峰值取各节点峰值中的最大值
    totalPeakUp = Math.max(totalPeakUp, usage.peakUp);
    totalPeakDown = Math.max(totalPeakDown, usage.peakDown);
    lines.push(formatUsageLine(name, usage, showDetail, showPeak));
  }

  const totalUsage: TrafficUsage = {
    up: totalUp,
    down: totalDown,
    peakUp: totalPeakUp,
    peakDown: totalPeakDown,
    hasData: true,
  };
  const message = [
    `${reportLabel(kind)} · ${formatPeriodTitle(kind, start, end)}`,
    formatUsageLine("合计", totalUsage, showDetail, showPeak),
    "",
    ...lines,
  ].join("\n");
  const event = eventName(kind);
  const emoji = eventEmoji(kind);
  const time = new Date().toISOString();
  const template = asString(config.template, "").trim();
  const renderedMessage = template
    ? replaceTemplate(template, {
        period: reportLabel(kind),
        period_short: formatPeriodTitle(kind, start, end),
        start: formatDate(start),
        end: formatDate(end),
        message,
        nodes: lines.join("\n"),
        total: formatBytes(totalUp + totalDown),
        total_up: formatBytes(totalUp),
        total_down: formatBytes(totalDown),
        node_count: String(nodeIds.length),
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
