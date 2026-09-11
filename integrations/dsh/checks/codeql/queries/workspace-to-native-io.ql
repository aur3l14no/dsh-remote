/**
 * @name Workspace input reaches a native IO candidate
 * @description Tool inputs or Session cwd reach modeled IO targets or arguments of unmodeled native calls; review required.
 * @kind path-problem
 * @problem.severity warning
 * @precision medium
 * @id dsh/workspace-to-native-io
 */

import NativeIo

module WorkspaceConfig implements DataFlow::ConfigSig {
  predicate isSource(DataFlow::Node source) {
    source =
      API::moduleImport("@deepseek-ai/dsh-tools")
          .getMember("defineTool")
          .getParameter(0)
          .getMember("execute")
          .getParameter(0)
          .getAMember()
          .asSource()
    or
    source =
      any(DataFlow::PropRead header | header.getPropertyName() = "header").getAPropertyRead("cwd")
  }

  predicate isSink(DataFlow::Node sink) {
    exists(DataFlow::InvokeNode call | isNativeIoCall(call) |
      sink = call.(FileSystemAccess).getAPathArgument()
      or
      sink = call.(SystemCommandExecution).getACommandArgument()
      or
      sink = call.(SystemCommandExecution).getArgumentList()
      or
      call instanceof SystemCommandExecution and sink = call.getOptionArgument(_, "cwd")
      or
      // Keep unmodeled native calls reviewable without guessing parameter roles.
      not call instanceof FileSystemAccess and
      not call instanceof SystemCommandExecution and
      sink = call.getAnArgument()
    )
  }
}

module WorkspaceFlow = TaintTracking::Global<WorkspaceConfig>;

import WorkspaceFlow::PathGraph

from WorkspaceFlow::PathNode source, WorkspaceFlow::PathNode sink
where WorkspaceFlow::flowPath(source, sink)
select sink.getNode(), source, sink,
  "Workspace input from $@ reaches a native IO candidate. Review parameter roles, the bound World and local-only guards.",
  source.getNode(), "tool input or Session cwd"
