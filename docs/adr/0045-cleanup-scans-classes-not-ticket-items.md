> Historical record: this ADR predates Issue #28 Navigator attendance and is retained only for provenance.

# 大扫除按同类扫描，不按票面条目施工

Status: accepted（authority/provenance: ADR 0019）

#58 的 F-ID 表、文件名和当前发现只是不完全实例与证据索引，不构成施工白名单。大扫除必须按已裁决的校验类别扫描全仓：凡具有同类拒绝行为的输入、输出、持久化、tool schema、发布 schema、runtime 二次校验、测试和文档，无论名称、位置、是否已列 ID，均在范围内。

施工完成后按同一类别重新扫描残余；任何保留实例都必须落入已批准的特别理由类别。扫描应发现并记录 Navigator 中的同类实例，但依 ADR 0020 及 ADR 0026–0030、0035 映射到 #28 的明确 deferral：这些是 #58 有理由的范围例外，不是默认保留，也不授权 #58 修改 Navigator。非 Navigator 实例仍须删除，或给出已批准的 retained-class reason。

验收判断的是同类行为是否清完并记录有理由的范围例外，不是既有清单是否逐项打勾。本裁决只规定 #58 的工作范围与验收方法，不新增常驻 scanner、gate 或免疫机制，也不削弱一次性同类扫描。
