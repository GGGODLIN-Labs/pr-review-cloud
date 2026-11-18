export const sampleReports = {
  1: `# 群組審查報告的發布與恢復

**PR**: [公開變更：允許重審同一組 PR](https://github.com/GGGODLIN/claude-pr-review/commit/54480b6edec28532822fda7e122c8bd06afb45d1)

這是根據 claude-pr-review 公開提交改寫的審查範例。提交紀錄保留了技術背景，輪次與對帳則示範本機報告的呈現方式。

## Round 1 · 初次審查

同一組 PR 推送新 commit 後可再次發布審查。發布前會歸檔上一輪的摘要與稽核檔。審查聚焦在發布中斷、報告驗證和檔案狀態。

| Finding | 審查軸 | 證據與影響 |
| :-- | :-- | :-- |
| R1-01 | 復原 | **群組報告歸檔恢復中斷**。若程序在搬移報告後被強制終止，原路徑缺檔，下一次發布不會自動恢復。 |
| R1-02 | 報告完整性 | **零發現標記偽造**。驗證器只辨識標記，可能把不完整的 findings 區段當作無發現。 |
| R1-03 | 檔案一致性 | **未修改的審查檔被覆寫**。寫入失敗後若一律覆寫稽核檔，會丟失未變動檔案的延伸屬性。 |

### 下輪驗證

用有效的零發現報告做正例，以 malformed findings 區段做反例，並核對寫入失敗前後的稽核檔及備份路徑。
`,
  2: `# 群組審查報告的發布與恢復

**Report projection schema**: 2
**PR**: [公開變更：驗證 findings 與恢復報告](https://github.com/GGGODLIN/claude-pr-review/commit/5bd860a730dc31e677e1be1e874da5637fe28244)
**Prior review continuity**: CHECKED (fixed 2 / still-open 1 / stale 0)

這是根據 claude-pr-review 公開提交改寫的審查範例。下表保留範例報告既有的跨輪狀態。

## Round 2 · 複審

### 上一輪 findings 對帳

| Finding | 結果 | 本輪證據 |
| :-- | :-- | :-- |
| R1-02 · 零發現標記偽造 | FIXED | 以 findings 區段原文驗證表頭、分隔線及唯一標記，允許合法的零發現報告發布。 |
| R1-03 · 未修改的審查檔被覆寫 | FIXED | 只有稽核檔確實被替換後才還原，未動過的檔案保留原屬性。 |
| R1-01 · 群組報告歸檔恢復中斷 | STILL_OPEN | [後續提交移除自動恢復日誌](https://github.com/GGGODLIN/claude-pr-review/commit/4aa8f53d35a6fb73f0472152c83d59a3a8057d57)。強制終止時保留備份，由操作者手動復原。 |

### 發布判斷

同意發布本輪修正。若程序遭強制終止，操作者先從備份恢復上一輪報告，再重新發布。
`,
};
