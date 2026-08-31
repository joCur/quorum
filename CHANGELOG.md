# Changelog

## [1.0.1](https://github.com/joCur/quorum/compare/v1.0.0...v1.0.1) (2026-08-31)


### Bug Fixes

* **release:** tag the release instead of stranding the merged release PR ([#151](https://github.com/joCur/quorum/issues/151)) ([09950fe](https://github.com/joCur/quorum/commit/09950fe122ec180db7c174388cceccaea40fa5e1))

## [1.0.0](https://github.com/joCur/quorum/compare/v0.1.0...v1.0.0) (2026-08-31)


### ⚠ BREAKING CHANGES

* **recording:** the env var RECORDING_MAX_SESSION_SECONDS is replaced by RECORDING_MAX_RECORDED_SECONDS (counts recorded audio only). Deployments setting the old variable must rename it; the old value is otherwise ignored and the 4h default applies.

### Features

* **auth:** add Keycloak to the compose stack and scaffold the API server ([#30](https://github.com/joCur/quorum/issues/30)) ([99c4f2e](https://github.com/joCur/quorum/commit/99c4f2e995ed7aae1c37a0048ea20a22b587fa07)), closes [#3](https://github.com/joCur/quorum/issues/3)
* **auth:** sign-up, and a workspace waiting on the other side of it ([#134](https://github.com/joCur/quorum/issues/134)) ([e3b130f](https://github.com/joCur/quorum/commit/e3b130fd1fe48a383202907621628bef41030b2a))
* **client:** add the crash-safe recording flow ([#37](https://github.com/joCur/quorum/issues/37)) ([6786bf2](https://github.com/joCur/quorum/commit/6786bf285448437e4db971fea6db91ce698c9cb3))
* **client:** an editorial landing page for signed-out visitors ([#129](https://github.com/joCur/quorum/issues/129)) ([dcf910a](https://github.com/joCur/quorum/commit/dcf910a0df5adb0334e8799c0b2a6a307a380d77))
* **client:** group the meetings list by day ([#122](https://github.com/joCur/quorum/issues/122)) ([91cc1c3](https://github.com/joCur/quorum/commit/91cc1c30d57c63918966c64ff1e263d6f6a6d1f5))
* **client:** meeting detail shows transcript and summary at once ([#124](https://github.com/joCur/quorum/issues/124)) ([8391ee2](https://github.com/joCur/quorum/commit/8391ee283f966a290acc8e9b6ffac22c4c117b3b))
* **client:** meeting detail with playback, transcript and summary ([#58](https://github.com/joCur/quorum/issues/58)) ([1d16aea](https://github.com/joCur/quorum/commit/1d16aea6d5bcbfa7ede4763842285e665a9e8956))
* **client:** meeting list with status badges, search and delete ([#52](https://github.com/joCur/quorum/issues/52)) ([d3f44c5](https://github.com/joCur/quorum/commit/d3f44c57b26d1ea1ef1236c72dede62a9ee6f418)), closes [#8](https://github.com/joCur/quorum/issues/8)
* **client:** one heading scale across every route ([#133](https://github.com/joCur/quorum/issues/133)) ([bfef85d](https://github.com/joCur/quorum/commit/bfef85df4796465bcdd063d35a78a96ab7995149)), closes [#126](https://github.com/joCur/quorum/issues/126)
* **client:** one sticky top bar for the whole app shell ([#119](https://github.com/joCur/quorum/issues/119)) ([4812a48](https://github.com/joCur/quorum/commit/4812a48589f78ffc221f895fc1f6301af140cd55))
* **client:** proxy API, WebSocket and health paths in the dev server ([#86](https://github.com/joCur/quorum/issues/86)) ([e17322c](https://github.com/joCur/quorum/commit/e17322cce0205587ed78eab3aab64651282210bd))
* **client:** re-authenticate on 401 instead of showing a load error ([#89](https://github.com/joCur/quorum/issues/89)) ([2cadbdc](https://github.com/joCur/quorum/commit/2cadbdcc5e2a4f7015a035e0ec6c86d67ab2641a)), closes [#53](https://github.com/joCur/quorum/issues/53)
* **client:** rebuild the recording screen on the v2 design ([#123](https://github.com/joCur/quorum/issues/123)) ([137318a](https://github.com/joCur/quorum/commit/137318abacbe6259e54d92d2ad2ad5812a93d351))
* **client:** render limit and quota refusals ([#96](https://github.com/joCur/quorum/issues/96)) ([9411f3f](https://github.com/joCur/quorum/commit/9411f3f7021b918466492dacdd0a1fd94932f9ae))
* **client:** scaffold the PWA shell with design tokens, i18n and auth ([#32](https://github.com/joCur/quorum/issues/32)) ([e9f04fd](https://github.com/joCur/quorum/commit/e9f04fddf620cd5f3eba269ff73b993f5f4a7149))
* **client:** settings as one panel of rows ([#121](https://github.com/joCur/quorum/issues/121)) ([ae20f70](https://github.com/joCur/quorum/commit/ae20f7034ca4530b7785580b7ccd4d5d26f03847))
* **client:** sign out from the settings screen ([#91](https://github.com/joCur/quorum/issues/91)) ([018cd22](https://github.com/joCur/quorum/commit/018cd229f0018399cda70e96c3944c2b6ec77982)), closes [#55](https://github.com/joCur/quorum/issues/55)
* **client:** template editor and regenerate with a chosen template ([#65](https://github.com/joCur/quorum/issues/65)) ([4681cd7](https://github.com/joCur/quorum/commit/4681cd7e339c7200789e71801b0a904661e22c3b))
* **client:** templates as a card grid with numbered sections ([#120](https://github.com/joCur/quorum/issues/120)) ([0f999fa](https://github.com/joCur/quorum/commit/0f999fa656c58ebfe02e0f99c096fcb94ec1ac41))
* **client:** transient confirmations with sonner ([#88](https://github.com/joCur/quorum/issues/88)) ([0c12f38](https://github.com/joCur/quorum/commit/0c12f384a5e09a3a15cdaffd674f2e6136b0b325))
* **client:** widen the shell content column to the prototype width ([#128](https://github.com/joCur/quorum/issues/128)) ([7dc5c07](https://github.com/joCur/quorum/commit/7dc5c079ea07204eaa3a19cfbd44bd22e12c794c))
* **design:** adopt the v2 token, font, radius and motion foundation ([#117](https://github.com/joCur/quorum/issues/117)) ([a4e23c6](https://github.com/joCur/quorum/commit/a4e23c6cd4d033417fba64c2528ba5a529627ad4))
* **design:** new brand icon — Q on espresso with a honey dot ([#118](https://github.com/joCur/quorum/issues/118)) ([d058f9b](https://github.com/joCur/quorum/commit/d058f9b1fb14714d08a7711b35ad0388af672501)), closes [#116](https://github.com/joCur/quorum/issues/116)
* **e2e:** give every suite run its own compose project and host ports ([#141](https://github.com/joCur/quorum/issues/141)) ([d5ba2c4](https://github.com/joCur/quorum/commit/d5ba2c4bab9edeb37cbc7c8152264676a1d78fc8))
* **infra:** a deployment is one compose file and a .env ([#98](https://github.com/joCur/quorum/issues/98)) ([a75894e](https://github.com/joCur/quorum/commit/a75894eddc02ab2eb8bf695875dd6608197af71b))
* **infra:** a Keycloak login theme in the product's design ([#132](https://github.com/joCur/quorum/issues/132)) ([65368fd](https://github.com/joCur/quorum/commit/65368fdb6133a4d3514832f586a204ff649178e8))
* **infra:** add server Dockerfile and fix compose build paths ([#34](https://github.com/joCur/quorum/issues/34)) ([8a808e9](https://github.com/joCur/quorum/commit/8a808e94534c5c0929cc6e1a98c5dc612dc154a2))
* **infra:** backup and restore runbook, and a KMS key preflight check ([#76](https://github.com/joCur/quorum/issues/76)) ([0c153d5](https://github.com/joCur/quorum/commit/0c153d534cf60f669dad7c512959a8eddcf4a042))
* **infra:** carry the Quorum icon into the sign-in tab ([#138](https://github.com/joCur/quorum/issues/138)) ([f7b22c4](https://github.com/joCur/quorum/commit/f7b22c47e81f5b47b56a4cd217b59ed78d89fbd1))
* **infra:** configurable mail delivery, and no reset link without it ([#131](https://github.com/joCur/quorum/issues/131)) ([dba7514](https://github.com/joCur/quorum/commit/dba7514521bc158fc13b4c7cd4759f870d0d5de8))
* **infra:** guard the dev and production realm files against silent drift ([#107](https://github.com/joCur/quorum/issues/107)) ([41a8b88](https://github.com/joCur/quorum/commit/41a8b8828d81d62c6d2dede435b45f2e501d5e03)), closes [#105](https://github.com/joCur/quorum/issues/105)
* **infra:** hardened production compose on published images ([#94](https://github.com/joCur/quorum/issues/94)) ([06c5871](https://github.com/joCur/quorum/commit/06c5871839976f0272c66a1828f81ce9d94fe47d))
* **observability:** alert rules, dashboards and the pipeline runbook ([#81](https://github.com/joCur/quorum/issues/81)) ([7d8df7f](https://github.com/joCur/quorum/commit/7d8df7f11382ae803ebb7db5aee82ff6019cbd49))
* **observability:** Prometheus metrics and a documented log schema ([#72](https://github.com/joCur/quorum/issues/72)) ([f102850](https://github.com/joCur/quorum/commit/f1028508501b675a0c29314053b7d61d894bf150))
* **recording:** capture online meetings as sound only ([#130](https://github.com/joCur/quorum/issues/130)) ([2f85e02](https://github.com/joCur/quorum/commit/2f85e024e4a9a3f9894059b6940420e7b5d522f1)), closes [#103](https://github.com/joCur/quorum/issues/103)
* **recording:** choose the summary template before recording ([#82](https://github.com/joCur/quorum/issues/82)) ([fb280eb](https://github.com/joCur/quorum/commit/fb280eb1a660fa3cde211a8e40ea00bc5456a4cc))
* **recording:** keep the recording alive across in-app navigation ([#108](https://github.com/joCur/quorum/issues/108)) ([75584f5](https://github.com/joCur/quorum/commit/75584f55f758660d55ca30240381a4a77d24071e))
* **recording:** let the user choose the microphone ([#106](https://github.com/joCur/quorum/issues/106)) ([3cd4985](https://github.com/joCur/quorum/commit/3cd4985d7ccb3abbf445301410298ec77f95d6bd)), closes [#102](https://github.com/joCur/quorum/issues/102)
* **recording:** pause and resume without ending the session ([#92](https://github.com/joCur/quorum/issues/92)) ([b1365da](https://github.com/joCur/quorum/commit/b1365da86770637171935e87e4cc855b8b65a81a))
* **release:** bump the remaining workspace manifests with the release too ([#150](https://github.com/joCur/quorum/issues/150)) ([02d04ae](https://github.com/joCur/quorum/commit/02d04ae2eb46d87947f22d4f72b5b7224b728cfe)), closes [#147](https://github.com/joCur/quorum/issues/147)
* **server:** add WebSocket recording endpoint with chunk persistence ([#29](https://github.com/joCur/quorum/issues/29)) ([226fc28](https://github.com/joCur/quorum/commit/226fc2816bd7a5c824266e50fb7449fc95b4515b)), closes [#4](https://github.com/joCur/quorum/issues/4)
* **server:** audio playback and the meeting deletion cascade ([#49](https://github.com/joCur/quorum/issues/49)) ([8c060c5](https://github.com/joCur/quorum/commit/8c060c57e4bc565ace3fcee4bfec7e1e173160a2)), closes [#8](https://github.com/joCur/quorum/issues/8)
* **server:** meeting list and detail API with derived pipeline status ([#48](https://github.com/joCur/quorum/issues/48)) ([1386ec8](https://github.com/joCur/quorum/commit/1386ec83c453224e7362b90b75f9ee2d054d3335)), closes [#8](https://github.com/joCur/quorum/issues/8)
* **server:** per-user limits resolver and storage/monthly quotas ([#79](https://github.com/joCur/quorum/issues/79)) ([f50b663](https://github.com/joCur/quorum/commit/f50b6635dba08fed722ed1147082f16b293ad224))
* **server:** per-user REST rate limits and queue fairness ([#77](https://github.com/joCur/quorum/issues/77)) ([3c7da91](https://github.com/joCur/quorum/commit/3c7da917fdc4bf3a066e0cd573b474cca211bbe9))
* **server:** session limits and WebSocket rate limits for the recording endpoint ([#70](https://github.com/joCur/quorum/issues/70)) ([acabccb](https://github.com/joCur/quorum/commit/acabccba8c4779c74a71dbc30a88d040dacd416f))
* **server:** summary template CRUD, regenerate endpoint and output language ([#63](https://github.com/joCur/quorum/issues/63)) ([8cab0da](https://github.com/joCur/quorum/commit/8cab0da320f3c1a2b844a46d096680b402b70d7f))
* **templates:** per-user default summary template ([#71](https://github.com/joCur/quorum/issues/71)) ([6c69cbe](https://github.com/joCur/quorum/commit/6c69cbe2f48b64938d053b12c8c8d7bcbbaf178c))
* **worker:** abandon a job whose meeting was deleted mid-flight ([#62](https://github.com/joCur/quorum/issues/62)) ([99840e5](https://github.com/joCur/quorum/commit/99840e54f038fd43117dce1b559231e3d6bda60f))
* **worker:** add the production Dockerfile and enable the compose service ([#47](https://github.com/joCur/quorum/issues/47)) ([9050042](https://github.com/joCur/quorum/commit/9050042b0ce1469df9ba34f83dc56b3ebf7a10f4)), closes [#41](https://github.com/joCur/quorum/issues/41)
* **worker:** transcription worker from chunk manifest to transcript ([#33](https://github.com/joCur/quorum/issues/33)) ([ce21909](https://github.com/joCur/quorum/commit/ce219099f57cfec3d0865a5f22d358ada87b715e)), closes [#6](https://github.com/joCur/quorum/issues/6)


### Bug Fixes

* **client:** move the landing page to the product root ([#143](https://github.com/joCur/quorum/issues/143)) ([8c09c72](https://github.com/joCur/quorum/commit/8c09c7271d29d80664e84e25fc7408fa63926208))
* **e2e:** fail the run when its environment is dirty ([#135](https://github.com/joCur/quorum/issues/135)) ([a069887](https://github.com/joCur/quorum/commit/a0698872a22c449d951b2f38cc8b95f46bfcc4db))
* **keycloak:** set sslRequired=none in the dev realm import ([#45](https://github.com/joCur/quorum/issues/45)) ([1beaedc](https://github.com/joCur/quorum/commit/1beaedc287411b240e29321a12030b2210d49f10)), closes [#44](https://github.com/joCur/quorum/issues/44)
* **server:** give the regenerate rate limit its own counter ([#83](https://github.com/joCur/quorum/issues/83)) ([c1b00dc](https://github.com/joCur/quorum/commit/c1b00dc651fde6fe6f6a1fa1f8497d4d4d381ec8))
