// Use the SDK's public URL/connect APIs. Its 1.3.6 chromium wrapper still checks a
// legacy query field and can otherwise launch a second browser for a path-form URL.
export function persistentConnector(connect,endpointURLString) {
  return (binding,sessionId)=>{
    const endpoint=new URL(endpointURLString(binding,{sessionId}));
    // This is the same persistent-default-context flag set by the SDK CDP wrapper.
    endpoint.searchParams.set('persistent','true');
    return connect(endpoint.toString());
  };
}
