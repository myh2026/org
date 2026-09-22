# ============================================================================
# fixtures/sast/bad-sample.py — SAST 坏样本（#146 · v0.5.22）
# ----------------------------------------------------------------------------
# 故意携带 5 类危险模式（测试专用语料，密钥均为假样例形状，非真实凭据）：
#   ① 硬编码密钥（sk-ant- / ghp_ / AKIA 三形态 —— 内置密钥规则面）
#   ② eval 动态执行（ruff S307 + 内置注入规则面）
#   ③ SQL 字符串拼接（ruff S608 + 内置 SQL 规则面）
#   ④ shell 拼接（ruff S605 + 内置 shell 规则面）
#   ⑤ 弱随机做 token（ruff S311 + 内置弱随机规则面）
# 双车道对拍：tests/sast.test.ts 用本文件跑 ruff 车道（--select S）与内置
# 降级车道（engine:"builtin"）双对拍 —— 两车道各有产出且规则面互补
# （ruff 拿 S 码诊断；内置拿密钥形态 —— ruff 只按变量名认密钥，内置认值形状）。
# ============================================================================

import os
import random

# ① 硬编码密钥（三形态假样例）
API_KEY = "sk-ant-abcdefghijklmnopqrstuvwxyz123456"
GH_TOKEN = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkl"
AWS_KEY = "AKIAIOSFODNN7EXAMPLE"


# ② eval 动态执行（注入面）
def run_user_code(code):
    return eval(code)


# ③ SQL 字符串拼接（注入面）
def load_user(user_id):
    sql = "SELECT * FROM users WHERE id = " + user_id
    return sql


# ④ shell 拼接（注入面）
def dump_file(fname):
    os.system("cat " + fname)


# ⑤ 弱随机做 token（密码学用途）
def make_token():
    return random.random()
