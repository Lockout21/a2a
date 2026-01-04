/**
 * 自动生成的文件 - 请勿手动修改
 *
 * 此文件由 scripts/generate-proto-content.mjs 生成
 * 包含 agent.proto 的 JSON 表示，用于 @grpc/proto-loader 的 fromJSON() 加载
 */

/**
 * 使用 Record 类型避免 protobufjs 的 INamespace 类型约束问题
 * IMethod 要求 comment 是必需字段，但 protobufjs.toJSON() 不生成该字段
 */
export const PROTO_JSON: Record<string, unknown> = {
  "nested": {
    "agent": {
      "nested": {
        "v7": {
          "nested": {
            "Agent": {
              "methods": {
                "Execute": {
                  "requestType": "Message",
                  "requestStream": true,
                  "responseType": "Message",
                  "responseStream": true
                },
                "GetAgentCard": {
                  "requestType": "GetAgentCardRequest",
                  "responseType": "AgentCard"
                },
                "Check": {
                  "requestType": "HealthCheckRequest",
                  "responseType": "HealthCheckResponse"
                }
              }
            },
            "Message": {
              "oneofs": {
                "content": {
                  "oneof": [
                    "call",
                    "cancel",
                    "business"
                  ]
                }
              },
              "fields": {
                "messageId": {
                  "type": "string",
                  "id": 1
                },
                "timestamp": {
                  "type": "int64",
                  "id": 2
                },
                "sessionId": {
                  "type": "string",
                  "id": 3
                },
                "traceId": {
                  "type": "string",
                  "id": 4
                },
                "from": {
                  "type": "AgentCard",
                  "id": 5
                },
                "call": {
                  "type": "Call",
                  "id": 10
                },
                "cancel": {
                  "type": "Cancel",
                  "id": 11
                },
                "business": {
                  "type": "Business",
                  "id": 20
                }
              }
            },
            "Call": {
              "fields": {
                "text": {
                  "type": "string",
                  "id": 1
                },
                "data": {
                  "type": "bytes",
                  "id": 2
                }
              }
            },
            "Cancel": {
              "fields": {
                "text": {
                  "type": "string",
                  "id": 1
                },
                "data": {
                  "type": "bytes",
                  "id": 2
                }
              }
            },
            "Business": {
              "fields": {
                "type": {
                  "type": "string",
                  "id": 1
                },
                "text": {
                  "type": "string",
                  "id": 2
                },
                "data": {
                  "type": "bytes",
                  "id": 3
                }
              }
            },
            "GetAgentCardRequest": {
              "fields": {}
            },
            "AgentCard": {
              "fields": {
                "agentId": {
                  "type": "string",
                  "id": 1
                },
                "name": {
                  "type": "string",
                  "id": 2
                },
                "version": {
                  "type": "string",
                  "id": 3
                },
                "description": {
                  "type": "string",
                  "id": 4
                },
                "skills": {
                  "rule": "repeated",
                  "type": "SkillInfo",
                  "id": 10
                },
                "defaultSkill": {
                  "type": "string",
                  "id": 11
                },
                "endpoint": {
                  "type": "Endpoint",
                  "id": 12
                },
                "role": {
                  "type": "string",
                  "id": 13
                }
              }
            },
            "SkillInfo": {
              "fields": {
                "name": {
                  "type": "string",
                  "id": 1
                },
                "description": {
                  "type": "string",
                  "id": 2
                },
                "inputSchema": {
                  "type": "string",
                  "id": 6
                },
                "outputSchema": {
                  "type": "string",
                  "id": 7
                }
              }
            },
            "Endpoint": {
              "fields": {
                "host": {
                  "type": "string",
                  "id": 1
                },
                "port": {
                  "type": "int32",
                  "id": 2
                },
                "namespace": {
                  "type": "string",
                  "id": 3
                },
                "address": {
                  "type": "string",
                  "id": 4
                }
              }
            },
            "HealthCheckRequest": {
              "fields": {}
            },
            "HealthCheckResponse": {
              "fields": {
                "status": {
                  "type": "Status",
                  "id": 1
                },
                "message": {
                  "type": "string",
                  "id": 2
                }
              },
              "nested": {
                "Status": {
                  "values": {
                    "UNKNOWN": 0,
                    "HEALTHY": 1,
                    "UNHEALTHY": 2
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
