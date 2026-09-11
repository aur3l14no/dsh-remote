/**
 * @name Native IO capability reaches a call
 * @description Follows aliases, parameters, returns and properties from Node IO modules to calls.
 * @kind path-problem
 * @problem.severity recommendation
 * @precision medium
 * @id dsh/native-io-use
 */

import NativeIo
import NativeIoFlow::PathGraph

from NativeIoFlow::PathNode source, NativeIoFlow::PathNode sink
where NativeIoFlow::flowPath(source, sink)
select sink.getNode(), source, sink, "Native IO capability from $@ reaches this call.",
  source.getNode(), "module import"
