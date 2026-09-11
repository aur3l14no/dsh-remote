import javascript

/** Track native module values, including member extraction, to invocations. */
module NativeIoConfig implements DataFlow::ConfigSig {
  predicate isSource(DataFlow::Node source) {
    source = DataFlow::moduleImport(["fs", "fs/promises", "child_process"])
  }

  predicate isSink(DataFlow::Node sink) { sink = any(DataFlow::InvokeNode call).getCalleeNode() }

  predicate isAdditionalFlowStep(DataFlow::Node before, DataFlow::Node after) {
    before = after.(DataFlow::PropRead).getBase()
  }
}

module NativeIoFlow = DataFlow::Global<NativeIoConfig>;

predicate isNativeIoCall(DataFlow::InvokeNode call) { NativeIoFlow::flow(_, call.getCalleeNode()) }
