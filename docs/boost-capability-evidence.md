# Boost capability evidence (validate_only probes)

- date: 2026-09-14T12:02:05.842Z
- graph version: v25.0
- ad account: 1390021406359848
- method: validate_only adset/creative creation (no spend, no delivery); probe campaign created PAUSED and deleted afterwards

| id | question | result | meta error | prior expectation |
|---|---|---|---|---|
| E1 | sanity: FB post adset, [facebook,instagram], REACH | PASS | — | pass |
| E2 | IG media adset with facebook platform — is the IG lock required? | PASS | — | fail |
| E3 | IG media adset, instagram-only — current behavior valid? | PASS | — | pass |
| E4 | THRUPLAY goal + ON_POST (video/reel context) | FAIL | `{"userMsg":"You can't use the selected performance goal with your campaign objective. Please select a different goal or edit your campaign.","userTitle":"Performance goal isn't available","code":100,"subcode":2490408,"raw":"Graph API POST act_1390021406359848/adsets failed: {\"error\":{\"message\":\"Invalid parameter\",\"type\":\"OAuthException\",\"code\":100,\"error_data\":\"{\\\"blame_field_specs\\\":[[\\\"optimization_goal\\\"]]}\",\"error_subcode\":2490408,\"is_transient\":false,\"error_user_title\":\"Performance goal isn't available\",\"error_user_msg\":\"You can't use the selected performance goal with your campaign objective. Please select a different goal or edit your campaign.\",\"fbtrace_id\":\"A8XK-4tJk5Mz1MNVIF2a_dg\"}}"}` | unknown |
| E5 | THRUPLAY goal + ON_POST (photo-post context) | FAIL | `{"userMsg":"You can't use the selected performance goal with your campaign objective. Please select a different goal or edit your campaign.","userTitle":"Performance goal isn't available","code":100,"subcode":2490408,"raw":"Graph API POST act_1390021406359848/adsets failed: {\"error\":{\"message\":\"Invalid parameter\",\"type\":\"OAuthException\",\"code\":100,\"error_data\":\"{\\\"blame_field_specs\\\":[[\\\"optimization_goal\\\"]]}\",\"error_subcode\":2490408,\"is_transient\":false,\"error_user_title\":\"Performance goal isn't available\",\"error_user_msg\":\"You can't use the selected performance goal with your campaign objective. Please select a different goal or edit your campaign.\",\"fbtrace_id\":\"AahI5xHg-z8ikz7NQqSRTNg\"}}"}` | unknown |
| E7 | messenger_positions [messenger_home] on FB post | PASS | — | unknown |
| E8 | audience_network_positions [classic] on FB post | PASS | — | unknown |
| E9 | IMPRESSIONS goal + ON_POST — is the v20 deprecation enforced? | FAIL | `{"userMsg":"Optimising for impressions is no longer available. You can optimise for reach and we'll show your ads to as many people as possible.","userTitle":"Impressions goal is no longer available","code":100,"subcode":3858327,"raw":"Graph API POST act_1390021406359848/adsets failed: {\"error\":{\"message\":\"Invalid parameter\",\"type\":\"OAuthException\",\"code\":100,\"error_subcode\":3858327,\"is_transient\":false,\"error_user_title\":\"Impressions goal is no longer available\",\"error_user_msg\":\"Optimising for impressions is no longer available. You can optimise for reach and we'll show your ads to as many people as possible.\",\"fbtrace_id\":\"AEZHKVTkQazlOnG_Di4Cq3H\"}}"}` | fail |
| E6 | FB story object as ad creative (story boostability) | FAIL | `{"userMsg":null,"userTitle":null,"code":100,"subcode":null,"raw":"Graph API POST act_1390021406359848/adcreatives failed: {\"error\":{\"message\":\"(#100) Invalid post_id parameter\",\"type\":\"OAuthException\",\"code\":100,\"fbtrace_id\":\"A1KHQnHvvAZfeBLzryGu-EL\"}}"}` | unknown |
