# ORG Run Report

## 交付物（3）
- (fetched raw notices)
- [{"title":"关于修订公司内部审计制度的公告","date":"3月14日","date_status":"unparsed","dept":"审计部","category":"announcement"},{"title":"关于召开2024年第一季度业绩说明会的公告","date":"2024-03-10","date_status":"ok","dept":"董事会办公室","category":"announcement"},{"title":"关于召开职工代表大会的通知","date":"2024-03-12","date_status":"ok","dept":"工会办公室","category":"notice"},{"title":"关于使用部分闲置募集资金进行现金管理的公告","date":"2024-03-10","date_status":"ok","dept":"财务部","category":"announcement"},{"title":"关于2023年度环境信息披露报告编制工作安排的通知","date":"2024-03-12","date_status":"ok","dept":"安全环保部","category":"notice"}]
- (validation verdict artifact)

## 资产（3）
- frozen notice-parser.norm_date
- expert record-validator@1.0.0
- memory: task memory index: 3 entries

## 成本谱系
tokens=480 revises=1 model_calls=5

## 运行时动力学
journal→fixture 基准题 4 条（生产即出题）
评分卡漂移告警 0 条（静默更新检测）

mission: 抓取某站点近一周公告，输出结构化表格
run_id: 2026-09-12T05-32-44-664Z
accepted 3 / 3 subtasks
- task#1 fetch :: (fetched raw notices) (coverage 1.00)
- task#2 parse :: [{"title":"关于修订公司内部审计制度的公告","date":"3月14日","date_status":"unparsed","dept":"审计部","category":"announcement"},{"title":"关于召开2024年第一季度业绩说明会的公告","date":"2024-03-10","date_status":"ok","dept":"董事会办公室","category":"announcement"},{"title":"关于召开职工代表大会的通知","date":"2024-03-12","date_status":"ok","dept":"工会办公室","category":"notice"},{"title":"关于使用部分闲置募集资金进行现金管理的公告","date":"2024-03-10","date_status":"ok","dept":"财务部","category":"announcement"},{"title":"关于2023年度环境信息披露报告编制工作安排的通知","date":"2024-03-12","date_status":"ok","dept":"安全环保部","category":"notice"}] (coverage 1.00)
- task#3 validate :: (validation verdict artifact) (coverage 1.00)
