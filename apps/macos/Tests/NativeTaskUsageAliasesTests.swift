import Foundation
@main @MainActor struct IndependentUsageAliases {
 static func main() {
  let vectors:[(String,[String:Any],String)]=[
   ("conflicting-input",["input_tokens":3,"prompt_tokens":99],"输入未知"),
   ("conflicting-output",["output_tokens":4,"completion_tokens":88],"输出未知"),
   ("declared-malformed-input",["input_tokens":true,"prompt_tokens":3],"输入未知"),
   ("matching-aliases",["input_tokens":3,"prompt_tokens":3,"output_tokens":4,"completion_tokens":4,"total_tokens":7],"输入3 · 输出4 · 合计7"),
   ("measured-zero",["input_tokens":0,"prompt_tokens":0],"输入0")
  ]
  var failures=0
  for(name,value,expected)in vectors {let actual=NativeTaskProjection.usage(value);let pass=actual.contains(expected);if !pass {failures+=1};print("\(pass ? "PASS":"FAIL") \(name): \(actual)")}
  print("RESULT \(vectors.count-failures) passed / \(failures) failed");exit(failures==0 ? 0:1)
 }
}
