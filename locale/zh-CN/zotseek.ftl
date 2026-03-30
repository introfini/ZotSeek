# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

## Context menu items

zotseek-menu-findSimilar = 查找相似文献
zotseek-menu-openZotSeek = 打开 ZotSeek...
zotseek-menu-indexSelected = 为 ZotSeek 索引选中项
zotseek-menu-indexCollection = 索引当前合集
zotseek-menu-updateLibrary = 更新文献库索引
zotseek-menu-removeFromIndex = 从 ZotSeek 索引中移除
zotseek-menu-findRelated = 查找相关文献

## Toolbar

zotseek-toolbar-openZotSeek = 打开 ZotSeek
zotseek-toolbar-findSimilar = 查找相似文献

## Preference pane

zotseek-pref-title = ZotSeek
zotseek-pref-indexStatistics = 索引统计
zotseek-pref-papersIndexed = 已索引文献
zotseek-pref-totalChunks = 总分块数
zotseek-pref-storageUsed = 存储占用
zotseek-pref-model = 模型：
zotseek-pref-avg = 平均：
zotseek-pref-chunksPerPaper = 分块/文献
zotseek-pref-lastIndexed = 上次索引：
zotseek-pref-refreshStats =
    .label = 刷新统计
zotseek-pref-compactDatabase =
    .label = 压缩数据库
zotseek-pref-indexModeMismatch = 索引模式不匹配
zotseek-pref-indexModeMismatchDesc = 您的索引是使用{ $indexedMode }模式构建的，但当前设置为{ $currentMode }。
zotseek-pref-indexModeMismatchAction = 点击下方"重建索引"以应用新的索引模式设置。
zotseek-pref-indexingMode = 索引模式
zotseek-pref-abstractOnly = 仅摘要
zotseek-pref-abstractOnlyMenu =
    .label = 仅摘要（更快）
zotseek-pref-abstractSpeed = 快速 • 每篇文献约1个分块
zotseek-pref-abstractDesc = 索引标题和摘要。适合按主题查找文献。
zotseek-pref-fullPaper = 全文
zotseek-pref-fullPaperMenu =
    .label = 全文（更彻底）
zotseek-pref-fullSpeed = 彻底 • 每页1-2个分块
zotseek-pref-fullDesc = 索引完整PDF内容及页码。可查找特定段落。
zotseek-pref-zotero7Note = Zotero 7 注意：
zotseek-pref-zotero7Desc = 由于WASM差异，Zotero 7上的全文索引较慢。建议大型文献库使用摘要模式。
zotseek-pref-autoIndexing = 自动索引
zotseek-pref-autoIndexLabel =
    .label = 自动索引新条目
zotseek-pref-autoIndexDesc = 添加到文献库的新文献将在后台自动索引。
zotseek-pref-delayLabel = 索引前延迟：
zotseek-pref-seconds = 秒
zotseek-pref-delayDesc = 添加最后一个条目后等待这么长时间再开始自动索引。
zotseek-pref-searchSettings = 搜索设置
zotseek-pref-resultsToShow = 显示结果数
zotseek-pref-resultsToShowDesc = 显示多少个匹配结果（5-100）
zotseek-pref-minSimilarity = 最低相似度
zotseek-pref-minSimilarityDesc = % — 过滤低质量匹配（0-100）
zotseek-pref-advancedSettings = 高级设置
zotseek-pref-maxTokens = 每分块最大令牌数
zotseek-pref-maxTokensDesc = 分块大小上限（200-8000）
zotseek-pref-maxChunks = 每篇文献最大分块数
zotseek-pref-maxChunksDesc = 长文档限制（1-200）
zotseek-pref-excludeBooks =
    .label = 排除书籍
zotseek-pref-excludeBooksDesc = 书籍缺乏论文结构且太长，不适合索引。
zotseek-pref-excludeTag = 排除标签
zotseek-pref-excludeTagDesc = 带有此标签的条目将在索引时被跳过。留空以禁用。
zotseek-pref-actions = 操作
zotseek-pref-updateIndex =
    .label = 更新索引
zotseek-pref-recommended = ✓ 推荐
zotseek-pref-updateIndexDesc = 索引文献库中所有未索引的条目。可从上次中断处安全恢复。
zotseek-pref-rebuildIndex =
    .label = 重建索引
zotseek-pref-rebuildIndexDesc = 清除并使用当前设置重新索引所有条目。更改索引模式后使用。
zotseek-pref-clearIndex =
    .label = 清除索引
zotseek-pref-destructive = ⚠ 有破坏性
zotseek-pref-clearIndexDesc = 从数据库中删除所有嵌入向量。之后需要重新索引。
zotseek-pref-about = 关于
zotseek-pref-githubRepo =
    .value = GitHub 仓库
zotseek-pref-modelLine = 模型：{ $model }
zotseek-pref-avgLine = 平均：{ $avg } 分块/文献
zotseek-pref-lastIndexedLine = 上次索引：{ $date }
zotseek-pref-compacted = 数据库已压缩
zotseek-pref-compactionFailed = 压缩失败

## Search dialog

zotseek-search-search =
    .value = 搜索：
zotseek-search-placeholder =
    .placeholder = 输入搜索查询（输入时自动搜索）...
zotseek-search-addQuery =
    .label = +
    .tooltiptext = 添加查询以进行AND/OR组合
zotseek-search-searchBtn =
    .label = 搜索
zotseek-search-and =
    .label = AND
zotseek-search-or =
    .label = OR
zotseek-search-using =
    .value = 使用
zotseek-search-minimum =
    .label = 最小值
zotseek-search-product =
    .label = 乘积
zotseek-search-average =
    .label = 平均值
zotseek-search-andDesc =
    .value = — 结果必须匹配两个查询
zotseek-search-query2 =
    .value = 查询 2：
zotseek-search-query3 =
    .value = 查询 3：
zotseek-search-query4 =
    .value = 查询 4：
zotseek-search-enterQuery = 输入查询 { $n }...
zotseek-search-removeQuery =
    .label = ✕
    .tooltiptext = 删除此查询
zotseek-search-mode =
    .value = 模式：
zotseek-search-modeHybrid =
    .label = 🔗 混合（推荐）
zotseek-search-modeSemantic =
    .label = 🧠 仅语义
zotseek-search-modeKeyword =
    .label = 🔤 仅关键词
zotseek-search-modeDesc =
    .value = 匹配类型：🔗 两种搜索 · 🧠 AI匹配 · 🔤 关键词匹配
zotseek-search-results =
    .value = 结果：
zotseek-search-bySection = 按章节
zotseek-search-byLocation = 按位置（精确页码和段落）
zotseek-search-settings =
    .label = ⚙ 设置
    .tooltiptext = 打开 ZotSeek 设置
zotseek-search-openSelected =
    .label = 打开选中项
zotseek-search-close =
    .label = 关闭
zotseek-search-initializing = 正在初始化搜索...
zotseek-search-hybrid = 混合
zotseek-search-semantic = 语义
zotseek-search-keyword = 关键词
zotseek-search-loadingModel = 正在加载AI模型（首次可能需要稍等）...
zotseek-search-finding = { $mode }搜索：正在查找...
zotseek-search-findingMulti = { $mode }搜索（{ $op }）：正在查找...
zotseek-search-noItemsFound = 未找到条目
zotseek-search-showInLibrary = 在文献库中显示
zotseek-search-showItemsInLibrary = 在文献库中显示 { $count } 个条目
zotseek-search-addToCollection = 添加到合集
zotseek-search-noCollections = 无合集
zotseek-search-moreCollections = ... 及其他 { $count } 个
zotseek-search-foundItems = 找到 { $count } 个条目
zotseek-search-foundItemsFromMatches = 找到 { $count } 个条目（来自 { $matches } 个匹配）
zotseek-search-foundItemsQuery = 找到 { $count } 个条目（{ $query }）
zotseek-search-searching = 搜索中...
zotseek-search-searchLabel = 搜索
zotseek-search-searchingMoment = 即将搜索...
zotseek-search-failed = 搜索失败：{ $error }
zotseek-search-noItemsMatchingAll = 未找到匹配所有查询的条目
zotseek-search-matchBoth = — 结果必须匹配两个查询
zotseek-search-matchAll = — 结果必须匹配所有查询
zotseek-search-matchAny = — 结果可匹配任一查询

## Results table columns

zotseek-column-match = 匹配
zotseek-column-title = 标题
zotseek-column-authors = 作者
zotseek-column-year = 年份
zotseek-column-location = 位置
zotseek-column-section = 章节

## Source labels

zotseek-source-abstract = 摘要
zotseek-source-fulltext = 全文
zotseek-source-title = 标题
zotseek-source-methods = 方法
zotseek-source-results = 结果
zotseek-source-content = 内容
zotseek-search-hybrid-menuitem =
    .label = 🔗 混合（推荐）
zotseek-search-semantic-menuitem =
    .label = 🧠 仅语义
zotseek-search-keyword-menuitem =
    .label = 🔤 仅关键词

## Similar documents dialog

zotseek-similar-title =
    .title = 查找相似文献
zotseek-similar-similarTo = 相似于：{ " " }
zotseek-similar-loading = 加载中...
zotseek-similar-openSelected =
    .label = 打开选中项
zotseek-similar-close =
    .label = 关闭
zotseek-similar-initFailed = 初始化失败：{ $error }
zotseek-similar-noSource = 未选择源文献
zotseek-similar-finding = 正在查找相似文献...
zotseek-similar-loadingModel = 正在加载AI模型...
zotseek-similar-searching = 搜索中...
zotseek-similar-noResults = 未找到相似文献
zotseek-similar-found = 找到 { $count } 篇相似文献
zotseek-similar-searchFailed = 搜索失败：{ $error }

## Indexing progress

zotseek-indexing-title = ZotSeek 索引
zotseek-indexing-clearTitle = 正在清除 ZotSeek 索引
zotseek-indexing-clearConfirmTitle = 清除 ZotSeek 索引
zotseek-indexing-clearConfirmMsg = 这将删除所有存储的嵌入向量。您需要重新索引文献库。

    继续？
zotseek-indexing-initStorage = 正在初始化存储...
zotseek-indexing-deletingAll = 正在删除所有嵌入向量...
zotseek-indexing-clearedSuccess = 索引已成功清除！
zotseek-indexing-clearedMsg = 索引已成功清除。

    您现在可以重新索引文献库。
zotseek-indexing-rebuildTitle = 重建 ZotSeek 索引
zotseek-indexing-rebuildConfirmTitle = 重建 ZotSeek 索引
zotseek-indexing-rebuildConfirmMsg = 这将删除所有存储的嵌入向量并使用当前设置重建索引。

    根据文献库大小，这可能需要几分钟。

    继续？
zotseek-indexing-rebuildingTitle = 正在重建 ZotSeek 索引
zotseek-indexing-clearingExisting = 正在清除现有索引...
zotseek-indexing-existingCleared = ✓ 现有索引已清除
zotseek-indexing-loading = 加载中...
zotseek-indexing-alreadyInProgress = 索引已在进行中...
zotseek-indexing-selectItems = 请选择要索引的条目。
zotseek-indexing-selectCollection = 请先选择一个合集。

    （在左侧边栏中点击一个合集）
zotseek-indexing-emptyCollection = 合集"{ $name }"没有可索引的条目。
zotseek-indexing-updateTitle = ZotSeek - 更新文献库索引
zotseek-indexing-updateConfirmMsg = 这将为文献库中所有未索引的条目建立语义搜索索引。

    已索引的条目将被跳过。

    根据新条目数量，这可能需要几分钟。

    继续？
zotseek-indexing-noItemsSelected = 未选择条目
zotseek-indexing-removedItems = 已从索引中移除 { $count } 个条目
zotseek-indexing-notInIndex = 选中的条目不在索引中
zotseek-indexing-removeFailed = 从索引中移除失败
zotseek-indexing-mode = 索引模式：{ $mode }
zotseek-indexing-checking = 正在检查已索引的条目...
zotseek-indexing-skippedExcluded = ✓ 跳过 { $count } 个已排除条目（标签）
zotseek-indexing-skippedIndexed = ✓ 跳过 { $count } 个已索引条目
zotseek-indexing-allIndexed = 所有条目已索引！
zotseek-indexing-allInIndex = ✓ { $count } 个条目已在索引中
zotseek-indexing-nothingToIndex = 无需索引 — 所有条目均已是最新！
zotseek-indexing-loadingModel = 正在加载AI模型（Transformers.js）...
zotseek-indexing-modelLoaded = ✓ AI模型已加载
zotseek-indexing-batchExtracting = 批次 { $current }/{ $total }：正在提取文本...
zotseek-indexing-batchEmbedding = 批次 { $current }/{ $total }：正在生成嵌入向量...
zotseek-indexing-batchEmbeddingChunks = 批次 { $current }/{ $total }：嵌入分块
zotseek-indexing-chunksFailed = ⚠ { $count } 个分块已跳过：{ $items }
zotseek-indexing-batchSaving = 批次 { $current }/{ $total }：正在保存检查点...
zotseek-indexing-checkpoint = ✓ 检查点 { $current }/{ $total }：{ $items } 个条目，{ $chunks } 个分块已保存
zotseek-indexing-complete = 索引完成！
zotseek-indexing-completeMode = ✓ 模式：{ $mode }
zotseek-indexing-completePrevious = ✓ 先前已索引：{ $count } 个条目
zotseek-indexing-completeNew = ✓ 新索引：{ $count } 个条目
zotseek-indexing-completeChunks = ✓ 总分块数：{ $count }
zotseek-indexing-completeAvg = ✓ 平均分块/条目：{ $avg }
zotseek-indexing-completeDuration = ✓ 时长：{ $duration }
zotseek-indexing-completeNoContent = ⚠ 无内容：{ $count } 个条目
zotseek-indexing-completeSuccess = 索引已成功完成！
zotseek-indexing-cancelled = 索引已取消
zotseek-indexing-failed = 索引失败：{ $error }
zotseek-indexing-progressTitle = ZotSeek
zotseek-indexing-progressItem = 正在索引：{ $title }
zotseek-indexing-progressLoadingModel = 正在加载模型...
zotseek-indexing-allExcluded = 所有条目均已按标签排除
zotseek-indexing-extracting = 正在提取...
zotseek-indexing-noContent = ✗ 未找到内容
zotseek-indexing-embedding = 嵌入 { $current }/{ $total }...
zotseek-indexing-saving = 正在保存...
zotseek-indexing-chunksIndexed = ✓ { $count } 个分块已索引
zotseek-indexing-chunksIndexedWithFailed = ✓ { $count } 个分块已索引（{ $failed } 个失败）
