/**
 * Method cards: the GIS "how", as opposed to the tool catalog which is the "what".
 *
 * A card is what an expert would say before reaching for a tool: when this method
 * applies, what must be true first, what people get wrong, what has to be asked,
 * and what "done correctly" means. Retrieval for cards is deliberately separate
 * from tool search (stage 2 requirement) so a method can be recognised even when
 * the catalog has no matching tool name.
 *
 * `operation` links a card to the shared operation contract when one exists. Cards
 * whose method is a plain WASM tool leave it undefined and name the tool instead.
 * Everything here is descriptive: it must never claim a capability that
 * OPERATION_SUPPORT marks unsupported.
 */
import type { OperationId } from "../../shared/contracts/index.ts";

export type MethodExample = {
  /** A user-style query, in the language users actually type. */
  query: string;
  /** Tool the method would pick for this query (real catalog id). */
  toolId: string;
};

export type MethodCard = {
  id: string;
  title: string;
  /** Phrases that should retrieve this method. */
  triggers: string[];
  /** Shared operation semantics, when the method is contract-backed. */
  operation?: OperationId;
  /** What must hold before the first tool runs. */
  preconditions: string[];
  /** Questions that must be answered before running, if any. */
  clarify: string[];
  /** Common mistakes and the wrong request that invites them. */
  antiPatterns: string[];
  /** Checks that make the result acceptable rather than merely produced. */
  acceptance: string[];
  positiveExample: MethodExample;
  /** The wrong request; `toolId` is absent when nothing should run at all. */
  negativeExample: { query: string; toolId?: string; why: string };
};

export const METHOD_CARDS: MethodCard[] = [
  {
    id: "buffer-distance",
    title: "缓冲与服务范围",
    triggers: ["缓冲", "缓冲区", "服务半径", "多少米范围内", "周边 500 米"],
    operation: "gis.buffer",
    preconditions: [
      "输入是矢量点/线/面，且坐标系是 EPSG 编号。",
      "距离是正的公制/英制长度；负距离内缩不在 v1 契约内。",
      "浏览器端会先投影到本地米制 CRS，输出图层记录该分析 CRS。",
    ],
    clarify: ["距离单位是米还是公里？", "重叠的缓冲要不要合并成一个面？"],
    antiPatterns: [
      "把“500”直接当度：浏览器端按米制解释，度会得到 0.0005° 的近似退化结果。",
      "用缓冲做“范围内筛选”却不说明边界接触算不算：相交与包含必须显式选谓词。",
    ],
    acceptance: [
      "输出要素数与输入一致（除非要求 dissolve）。",
      "抽样点的到原要素距离与请求半径误差在 1 米量级。",
      "输出 CRS 为本地米制 CRS，而不是原经纬度。",
    ],
    positiveExample: { query: "给这几个监测点做 800 米缓冲", toolId: "buffer" },
    negativeExample: { query: "把行政区边界往里缩 500 米", why: "负距离内缩两引擎语义不一致，v1 契约直接拒绝。" },
  },
  {
    id: "reproject-crs",
    title: "坐标系与重投影",
    triggers: ["重投影", "转换坐标系", "投影到", "EPSG", "转成 UTM"],
    operation: "gis.reproject",
    preconditions: [
      "目标 CRS 必须是 EPSG:<编号> 形式，不接受 proj 字符串。",
      "源图层必须已有 CRS；没有就先让用户指定，绝不猜。",
    ],
    clarify: ["目标坐标系用哪一个 EPSG？", "只是为了量算，还是要与另一份数据叠加？"],
    antiPatterns: [
      "把“经纬度转成米”理解为换单位：这是换投影，不是乘系数。",
      "对已经是目标 CRS 的图层再建一份副本：契约会返回显式 no-op。",
    ],
    acceptance: ["输出 CRS 等于请求的 EPSG。", "要素数不变。", "同一 CRS 请求返回 no-op 而不是新数据集。"],
    positiveExample: { query: "把这份数据投影到 UTM 50N", toolId: "reproject" },
    negativeExample: { query: "把已经是 EPSG:4326 的数据再转成 4326", why: "无意义的重投影，契约返回 no-op，不产生新图层。" },
  },
  {
    id: "clip-overlay",
    title: "按范围裁剪与叠加",
    triggers: ["裁剪", "按范围裁", "只保留范围内", "掩膜", "clip"],
    operation: "gis.clip",
    preconditions: [
      "掩膜图层必须存在且是面。",
      "浏览器端只支持面与点；线裁剪会显式拒绝。",
      "两图层都在同一分析 CRS 下运算，属性保留规则要说明。",
    ],
    clarify: ["裁剪结果要保留原属性吗？", "边界上的要素算不算（相交 / 完全包含）？"],
    antiPatterns: [
      "用“裁剪”表达“删除范围内”：那是 erase，语义相反。",
      "拿点图层当掩膜裁剪面：结果为空不是数据问题，是参数问题。",
    ],
    acceptance: ["输出完全落在掩膜内。", "要素属性保留（或按约定只保留指定字段）。", "空结果要说明是输入不重叠，而不是静默返回空图层。"],
    positiveExample: { query: "按这个区界裁剪道路", toolId: "clip" },
    negativeExample: { query: "用这条线裁掉范围内的面", why: "线掩膜在浏览器端未接入，必须先转面或用桌面引擎。" },
  },
  {
    id: "dissolve-group",
    title: "融合与分组汇总",
    triggers: ["融合", "合并成一个面", "按类型合并", "dissolve", "去掉内部边界"],
    operation: "gis.dissolve",
    preconditions: [
      "输入是面图层。",
      "不分组时语义是“全部求并成一个要素”；分组时每组一个要素。",
      "浏览器 WASM 端目前不可用（见 OPERATION_SUPPORT 的 D1/D2 说明）。",
    ],
    clarify: ["按哪个字段分组？", "融合后要保留哪些属性（通常只保留分组字段）？"],
    antiPatterns: [
      "把融合当成“合并图层”：合并是 union/merge，会保留各要素。",
      "在浏览器端直接跑 dissolve：会写出损坏投影的 FGB，必须走桌面引擎。",
    ],
    acceptance: ["不分组时输出 1 个要素。", "分组时要素数等于分组基数。", "融合后面积不小于最大单块、不大于各组面积之和。"],
    positiveExample: { query: "按类型把这三个区融合成一个面", toolId: "dissolve" },
    negativeExample: { query: "在浏览器里把这 5 个缓冲融合", why: "浏览器 dissolve 会输出损坏投影；应改用桌面引擎或 union 后删列。" },
  },
  {
    id: "zonal-stats",
    title: "分区统计",
    triggers: ["分区统计", "按区统计", "按行政区统计", "平均高程", "每个区平均高程", "zonal", "统计每个面内的像元"],
    operation: undefined,
    preconditions: [
      "需要两个输入：分区面图层 + 像元栅格；分区面不是栅格。",
      "统计量必须是 mean/median/min/max/sum/stddev/count 之一。",
      "NoData 处理必须显式（忽略或当 0）。",
    ],
    clarify: ["统计哪个栅格字段/波段？", "NoData 算不算进分母？", "分区与像元不重合时按像元中心还是面积加权？"],
    antiPatterns: [
      "把分区面当栅格传给 zonal_statistics：manifest 即如此，按名调用会跑错。",
      "用属性表字段求平均冒充分区统计：那不是空间加权。",
    ],
    acceptance: ["分区数 = 统计结果行数。", "全 NoData 分区要返回空值而不是 0。", "抽样分区的均值可用手算像元复现。"],
    positiveExample: { query: "统计每个行政区内的平均高程", toolId: "zonal_statistics" },
    negativeExample: { query: "统计每个区的人口平均值", why: "这是属性聚合，不是栅格分区统计；直接对表分组即可。" },
  },
  {
    id: "area-length-measure",
    title: "面积与长度量算",
    triggers: ["面积", "周长", "长度", "多少平方公里", "量算"],
    operation: undefined,
    preconditions: [
      "地理坐标（EPSG:4326）要用测地线量算，不能直接用平面公式。",
      "投影坐标要用该投影的单位与比例因子；结果单位是米/平方米。",
    ],
    clarify: ["要平面面积还是椭球面积？", "结果是写回属性表还是只报告数值？"],
    antiPatterns: [
      "在 4326 上用 shoelace 算面积：单位是“平方度”，数值没有意义。",
      "把周长当长度：面用 length_m 表示周长，线才是长度。",
    ],
    acceptance: ["面积与已知真值（如 113.8 km² 的样区）误差在 0.5% 内。", "结果写入属性列并标明单位。"],
    positiveExample: { query: "算一下这三个区的面积", toolId: "calculate_geometry" },
    negativeExample: { query: "算这个点的面积", why: "点没有面积；应改为统计点数或缓冲成面后再算。" },
  },
  {
    id: "spatial-join",
    title: "空间连接与最近匹配",
    triggers: ["空间连接", "把属性连到点上", "最近站点", "join by location", "落在哪个区"],
    operation: undefined,
    preconditions: [
      "明确目标图层与连接图层谁保留几何。",
      "谓词（intersects / within / nearest）必须显式。",
      "字段名冲突要预先决定前缀策略。",
    ],
    clarify: ["一个点落在多个面里时保留哪一条？", "最近匹配有没有距离上限？"],
    antiPatterns: [
      "用属性 join 代替空间连接：没有公共键时结果为空。",
      "最近匹配不加距离上限，把 200 km 外的站点也连上。",
    ],
    acceptance: ["输出行数 = 目标行数（nearest 一对一）或按谓词可解释的多行。", "连接字段带前缀且无覆盖丢失。"],
    positiveExample: { query: "把站点属性连到最近的监测点上", toolId: "spatial_join" },
    negativeExample: { query: "按 ID 把两张表连起来", why: "有公共键时是属性连接，不需要空间谓词。" },
  },
  {
    id: "dem-hydrology",
    title: "DEM 水文分析",
    triggers: ["汇流", "流向", "流域", "填洼", "河网提取", "水文分析"],
    operation: undefined,
    preconditions: [
      "输入是投影后的 DEM（米制），地理坐标 DEM 的坡度/流向不可信。",
      "先填洼再算流向，否则内流区会截断河网。",
      "流量阈值决定河网密度，必须作为参数说明。",
    ],
    clarify: ["流量累积阈值取多少？", "要整条河网还是只到出口的流域？"],
    antiPatterns: [
      "跳过填洼直接算流向：平原区会出现大量平行/断流伪影。",
      "对 4326 DEM 算坡度：x/y 单位不一致，坡度数值失真。",
    ],
    acceptance: ["填洼后无负坡度/无内流单元。", "河网阈值变化时结果单调（阈值越大河网越短）。", "流域出口与 DEM 边界关系可解释。"],
    positiveExample: { query: "从这个 DEM 提取河网和流域", toolId: "wasm_d8_flow_accum" },
    negativeExample: { query: "用经纬度 DEM 直接算坡度", why: "经纬度像元不是正方形米制，坡度会系统性偏大。" },
  },
  {
    id: "slope-aspect",
    title: "坡度与坡向",
    triggers: ["坡度", "坡向", "slope", "aspect", "地形起伏"],
    operation: undefined,
    preconditions: ["DEM 已投影到米制 CRS。", "坡度单位（度/百分比）要明确。"],
    clarify: ["坡度要度还是百分比？", "坡向要正北顺时针 0–360 吗？"],
    antiPatterns: ["把坡向当方位角用于导航而不做磁偏角修正：GIS 里通常是真北。"],
    acceptance: ["坡度范围 0–90°。", "平地坡向返回 NoData 而不是 0。"],
    positiveExample: { query: "算这个 DEM 的坡度和坡向", toolId: "wasm_slope" },
    negativeExample: { query: "算这份矢量面的坡度", why: "坡度是栅格邻域运算，矢量面没有坡度。" },
  },
];

export function methodById(id: string): MethodCard | undefined {
  return METHOD_CARDS.find(card => card.id === id);
}

/** Retrieval used by the agent prompt: trigger phrase containment, no tool search. */
export function findMethods(query: string, limit = 2): MethodCard[] {
  const text = query.toLowerCase();
  return METHOD_CARDS
    .map(card => ({ card, hits: card.triggers.filter(trigger => text.includes(trigger.toLowerCase())).length }))
    .filter(entry => entry.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, limit)
    .map(entry => entry.card);
}