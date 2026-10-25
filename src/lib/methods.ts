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

export type GuardrailKind = "crs" | "units" | "overlay-double-count" | "nodata" | "predicate";

/** A check that prevents a plausible-looking but methodologically wrong run. */
export type MethodGuardrail = {
  kind: GuardrailKind;
  /** The invariant to establish before accepting a result. */
  check: string;
  /** What to do when the invariant cannot be established from the request/data. */
  next: string;
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
  /** Typed checks injected with the card; not a second tool catalog. */
  guardrails: MethodGuardrail[];
  /** Questions that must be answered before running, if any. */
  clarify: string[];
  /**
   * Verified catalog tool ids for this method, in execution order. Names only:
   * parameters still come from `search_browser_tools` parameter cards.
   */
  workflow?: string[];
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
    guardrails: [
      { kind: "crs", check: "源图层 CRS 已知且为 EPSG 编号；显示用的 WGS84 副本不能代替分析 CRS。", next: "CRS 缺失时先请用户指定，绝不猜测。" },
      { kind: "units", check: "缓冲区距离与单位同时明确，契约会换算为正的米制长度。", next: "用户未写单位时先追问米/公里/英里，不把裸数字当成度。" },
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
    guardrails: [
      { kind: "crs", check: "源 CRS 与目标 EPSG 都明确；同 CRS 请求必须是显式 no-op。", next: "缺少任一侧 CRS 时先追问，不以图层名称或范围猜测。" },
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
    guardrails: [
      { kind: "crs", check: "输入与掩膜都先落到同一分析 EPSG；不得用屏幕 WGS84 坐标直接裁剪。", next: "CRS 未知或不一致时先重投影或在计划中显式拒绝。" },
      { kind: "predicate", check: "相交、完全包含和边界接触是不同谓词，输出口径必须与用户选择一致。", next: "用户只说“范围内”时先追问边界接触算不算。" },
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
    guardrails: [
      { kind: "crs", check: "输入面图层有明确 EPSG；融合后的面积在投影米制 CRS 中核对。", next: "CRS 缺失或为经纬度时先重投影再做面积验收。" },
      { kind: "overlay-double-count", check: "重叠面融合后的面积不应大于各输入面积之和；分组汇总不得按切片重复累计。", next: "先 union/dissolve 去重，或按唯一源 id 建立显式计数口径。" },
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
    operation: "gis.zonal_statistics",
    preconditions: [
      "需要两个输入：分区面图层 + 像元栅格；分区面不是栅格。",
      "统计量必须是 mean/median/min/max/sum/stddev/count 之一。",
      "NoData 处理必须显式（忽略或当 0）。",
      "桌面 Python 引擎已实现；浏览器 WASM 仍拒绝，因为目录里的同名工具只接受栅格分区。",
    ],
    guardrails: [
      { kind: "crs", check: "分区面与数值栅格都有 EPSG，且分区会重投影到栅格 CRS 后按像元掩膜。", next: "任一 CRS 缺失时停止；不得用 WGS84 显示范围代替栅格网格。" },
      { kind: "units", check: "统计值保留栅格原生单位，像素计数与面积口径分开报告。", next: "用户要面积时先确认像元面积/投影单位，不把像元数冒充面积。" },
      { kind: "nodata", check: "NoData 是忽略还是当 0 已明确，并在结果中报告有效像元数。", next: "未指定时先追问；全 NoData 分区必须返回空值而不是 0。" },
    ],
    clarify: ["统计哪个栅格字段/波段？", "NoData 算不算进分母？", "分区与像元不重合时按像元中心还是面积加权？"],
    antiPatterns: [
      "把分区面当栅格传给 zonal_statistics：manifest 即如此，按名调用会跑错。",
      "用属性表字段求平均冒充分区统计：那不是空间加权。",
    ],
    acceptance: ["分区数 = 统计结果行数（含无交集分区的空值行）。", "全 NoData 分区返回空值而不是 0。", "抽样分区的均值可用手算像元复现。"],
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
    guardrails: [
      { kind: "crs", check: "面积/长度在适合 AOI 的局部投影米制 CRS 中计算，并记录该分析 CRS。", next: "只有 4326 时先选择局部投影，或明确改用测地线算法。" },
      { kind: "units", check: "输出字段标明 m、km、m² 或 km²，换算只做一次。", next: "用户未指定展示单位时保留米制并在报告中换算说明。" },
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
    id: "centroid-metric",
    title: "质心与中心点",
    triggers: ["质心", "centroid", "center point", "中心点", "几何中心"],
    operation: undefined,
    preconditions: [
      "质心是平面几何量；在 EPSG:4326 度坐标下直接算，较大或跨带要素会偏移。",
      "先投影到覆盖 AOI 的局部米制 CRS（如 UTM 带），算完再转回任务要求的 CRS。",
      "保留源图层的稳定唯一 id，并核对每个输入要素恰好对应一个质心。",
    ],
    guardrails: [
      { kind: "crs", check: "计算质心前确认输入为局部米制投影；只有 4326 时先重投影，算完再转回。", next: "按 AOI 选择 UTM/本地米制 EPSG；不要用度坐标下的平面质心冒充米级结果。" },
    ],
    clarify: ["输出用 WGS84 还是本地米制 CRS？", "是否保留源图层的哪个唯一 id？"],
    antiPatterns: [
      "直接在 4326 上算质心：大要素的偏移可超过 1 m，且随纬度/形状放大。",
      "用包络框中心或多边形顶点平均值代替真实面积质心。",
    ],
    acceptance: ["每个输入要素恰有一个质心点，唯一 id 集合与输入一致。", "质心落在源要素包络内；与局部米制参考质心的偏差满足任务容差。", "输出 CRS 与任务要求一致，字段未被截断或改名。"],
    positiveExample: { query: "为每个建筑面生成质心点", toolId: "centroid" },
    negativeExample: { query: "直接在地理坐标下算质心并声称米级精度", why: "度坐标下的平面质心不是米制质心；大要素或跨带数据会超过米级容差。" },
    workflow: ["reproject", "centroid"],
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
    guardrails: [
      { kind: "crs", check: "连接双方在同一分析 EPSG；最近距离在局部米制 CRS 中量算。", next: "CRS 缺失或不一致时先重投影，不直接比较经纬度距离。" },
      { kind: "overlay-double-count", check: "一对一连接的目标行数不得因一对多匹配而膨胀；多匹配要保留明细或聚合口径。", next: "先说明一个点落在多个面时保留哪条，或输出匹配次数而不是静默复制。" },
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
    guardrails: [
      { kind: "crs", check: "DEM 与上游派生栅格保持同一投影网格；坐标不是 4326 度。", next: "先重投影/重采样并核对网格尺寸，再开始流向链。" },
      { kind: "units", check: "坡度输出单位、像元尺寸和流量累积阈值采用同一米制口径。", next: "未说明阈值单位时先追问，不把像元数或度值当米制阈值。" },
    ],
    clarify: ["流量累积阈值取多少？", "要整条河网还是只到出口的流域？"],
    workflow: ["wasm_fill_depressions", "wasm_d8_pointer", "wasm_basins", "wasm_raster_to_vector_polygons"],
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
    guardrails: [
      { kind: "crs", check: "DEM 为投影米制栅格，x/y 像元尺寸同一单位。", next: "4326 DEM 先重投影，不能直接算坡度。" },
      { kind: "units", check: "坡度单位（度或百分比）与坡向角度约定在输出中明确。", next: "未指定时先追问，并在结果中写清单位。" },
    ],
    clarify: ["坡度要度还是百分比？", "坡向要正北顺时针 0–360 吗？"],
    antiPatterns: ["把坡向当方位角用于导航而不做磁偏角修正：GIS 里通常是真北。"],
    acceptance: ["坡度范围 0–90°。", "平地坡向返回 NoData 而不是 0。"],
    positiveExample: { query: "算这个 DEM 的坡度和坡向", toolId: "wasm_slope" },
    negativeExample: { query: "算这份矢量面的坡度", why: "坡度是栅格邻域运算，矢量面没有坡度。" },
  },
  {
    id: "overlay-double-count",
    title: "叠加汇总与重复计数",
    triggers: ["叠加", "求交", "相交", "intersection", "联合", "union", "重叠面积", "面积汇总", "重复计算", "double count"],
    preconditions: [
      "两个输入图层都有 EPSG CRS，并落到同一分析 CRS 后再叠加。",
      "汇总前定义去重键：唯一源 id、先 union/dissolve，或明确允许按切片多次计数。",
      "面积/长度只在投影米制 CRS 中求和，经纬度度数不能直接相加或全局换系数。",
    ],
    guardrails: [
      { kind: "crs", check: "输入、叠加结果和面积量算共用同一投影米制 EPSG；显示图层不参与计算。", next: "CRS 缺失时先追问；不同 CRS 时先在计划中显式重投影。" },
      { kind: "units", check: "汇总字段带 m²/km²（或 m/km）单位，换算只执行一次且保留原始数值。", next: "单位不明时停止汇总并先确认，不按字段名猜测。" },
      { kind: "overlay-double-count", check: "同一源面被切成多块时不得把每块面积都当独立源面积；去重后总量不得超过源面并集。", next: "按唯一源 id 去重、先 dissolve/union，或向用户确认“切片各计一次”的口径。" },
    ],
    clarify: ["同一源面跨多个目标区时，是按目标区各计一次，还是按源 id 只计一次？", "重叠区要保留明细，还是先融合成并集再汇总？"],
    antiPatterns: [
      "intersection 后直接 sum(area_m2)：一个源面跨 n 个目标面会被计 n 次，总和不等于源面并集面积。",
      "把 EPSG:4326 的度数当米乘固定系数：面积误差随纬度变化，不能全局换算。",
    ],
    acceptance: [
      "去重后的汇总面积不超过源面并集面积（明确容差除外）。",
      "每条汇总结果可追溯到唯一源 id；重复 id 有显式计数口径和备注。",
      "输出字段或报告标明面积/长度单位与分析 CRS。",
    ],
    positiveExample: { query: "求这两个面图层相交部分，并按唯一源面去重汇总面积", toolId: "intersection" },
    negativeExample: { query: "把相交结果的面积列全部相加，不管同一块被切了几次", why: "这会把切片重复计数；应先去重或按唯一源 id 汇总，并说明重叠口径。" },
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
