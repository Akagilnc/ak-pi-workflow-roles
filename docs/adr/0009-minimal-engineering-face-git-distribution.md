# 最小工程面：git 分发，npm/LICENSE 等拉动

Status: accepted

保持 GitHub remote 推送与 `pi install git:` 分发；CI 只跑 test 与 typecheck。分发形态为 git ref 或本地路径，不发 npm；npm 发布与 LICENSE 等第一个外部消费者拉动。
