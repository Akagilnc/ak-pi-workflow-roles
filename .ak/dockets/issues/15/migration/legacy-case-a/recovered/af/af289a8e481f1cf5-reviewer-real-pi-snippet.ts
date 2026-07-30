test("real Pi rejects completed when a schema-invalid Agent sibling never enters execute", async () => {
  await withHermeticHome(
    { prefix: "ak-reviewer-malformed-sibling-" },
    async ({ home: temp, agentDir }) => {
      const skillDir = resolve(temp, "code-review");
      const skillPath = resolve(skillDir, "SKILL.md");
      const taskPath = resolve(temp, "review-task.md");
      const rawSkill = [
        "---",
        "name: code-review",
        "description: review",
        "---",
        "",
        "# Canonical review",
      ].join("\n");
      let childStarts = 0;
      let audits = 0;
      await mkdir(skillDir, { recursive: true });
      await writeFile(skillPath, rawSkill);
      await writeFile(taskPath, "# Review task\nReview the fixed point.\n");
      const canonicalPath = await realpath(skillPath);
      const faux = fauxProvider({
        api: "ak-reviewer-malformed-sibling",
        provider: "ak-reviewer-malformed-sibling",
        tokenSize: { min: 1000, max: 1000 },
      });
      faux.setResponses([
        fauxAssistantMessage([
          fauxToolCall(AGENT_TOOL_NAME, {
            subagent_type: "general-purpose",
            description: "Valid leg",
            prompt: "Inspect the fixed point.",
          }, { id: "valid-leg" }),
          fauxToolCall(AGENT_TOOL_NAME, {
            subagent_type: "general-purpose",
            description: "Invalid leg",
            prompt: "This must fail schema validation.",
            unexpected: true,
          }, { id: "invalid-leg" }),
        ], { stopReason: "toolUse" }),
        fauxAssistantMessage(
          fauxToolCall(REVIEWER_OUTPUT_TOOL_NAME, {
            status: "completed",
            report: "An always-pass auditor must not accept this.",
          }, { id: "completed-after-invalid" }),
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("Completion was rejected before audit."),
      ]);
      const model = faux.getModel();
      const provider = {
        ...faux.provider,
        auth: {
          [REDACTED]
            name: "Malformed sibling test auth",
            async resolve() {
              return { auth: { [REDACTED] } };
            },
          },
        },
        getModels() {
          return [model];
        },
      };
      await withInProcessPi({
        cwd: temp,
        agentDir,
        faux,
        model,
        provider,
        modelsPath: null,
        extensionFactories: [createRoleRuntimeExtension({
          loadJudgeSoul: async () => "judge",
          loadReviewerSoul: async () => "reviewer",
          loadReviewerTask: async () =>
            "# Review task\nReview the fixed point.",
          loadCanonicalSkillBinding: async () =>
            reviewerBinding({
              raw: rawSkill,
              path: canonicalPath,
              baseDir: dirname(canonicalPath),
              body: "# Canonical review",
            }),
          runReviewerAgent: async () => {
            childStarts += 1;
            return { report: "valid report", workspaceDisposition: "deleted" };
          },
          transcriptFromContext: () => "",
          auditSoulCompliance: async () => ({ status: "pass" }),
          auditReviewerCompliance: async () => {
            audits += 1;
            return { status: "pass" };
          },
        })],
        additionalSkillPaths: [canonicalPath],
        noExtensions: true,
        systemPrompt: "REVIEWER TEST BASE",
        mode: "tui",
        flags: {
          "ak-role": "reviewer",
          "ak-review-task": taskPath,
        },
        noTools: "builtin",
        reviewerShutdown: true,
      }, async ({ loader, session, sessionManager }) => {
        assert.deepEqual(loader.getExtensions().errors, []);

        await session.prompt("Review this fixed point.");

        const toolResults = sessionManager.getEntries().filter((entry) =>
          entry.type === "message" && entry.message.role === "toolResult"
        );
        const resultFor = (id: string) =>
          toolResults.find((entry) =>
            entry.type === "message" &&
            entry.message.role === "toolResult" &&
            entry.message.toolCallId === id
          );
        const valid = resultFor("valid-leg");
        const invalid = resultFor("invalid-leg");
        const completed = resultFor("completed-after-invalid");
        assert.ok(
          valid?.type === "message" && valid.message.role === "toolResult",
        );
        assert.equal(valid.message.isError, false);
        assert.ok(
          invalid?.type === "message" && invalid.message.role === "toolResult",
        );
        assert.equal(invalid.message.isError, true);
        const invalidText = invalid.message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");
        assert.match(invalidText, /unexpected|additional propert/i);
        assert.ok(
          completed?.type === "message" &&
            completed.message.role === "toolResult",
        );
        assert.equal(completed.message.isError, true);
        const completedText = completed.message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");
        assert.match(completedText, /exact one-to-one match/);
        assert.match(completedText, /invalid-leg/);
        assert.match(completedText, /unexpected|additional propert/i);
        assert.equal(
          childStarts,
          1,
          "only the schema-valid sibling reaches execute",
        );
        assert.equal(
          audits,
          0,
          "completion reconciliation runs before the auditor",
        );
        assert.equal(
          toolResults.some((entry) =>
            entry.type === "message" &&
            entry.message.role === "toolResult" &&
            entry.message.toolName === REVIEWER_OUTPUT_TOOL_NAME &&
            !entry.message.isError
          ),
          false,
        );
        assert.equal(faux.getPendingResponseCount(), 0);
      });
    },
  );
});
