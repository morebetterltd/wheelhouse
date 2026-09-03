# wheelhouse-project-inn full-history leak audit

audited_repo: git@github.com:morebetterltd/wheelhouse.git
head: c4f632e5fbae58443141312fd5eac4a3e8eb30b1
root: a8b857e109690ace951f3bc340b9a233e453fce0
commit_count: 242
blob_count: 1326
scope: git rev-list HEAD history; every reachable unique blob (file content present in commit trees) plus every commit message
reporting: hits are sanitized as location + pattern class + content hash, not raw values.

## Findings

- raw pattern hits: absolute-home-path 7
- raw pattern hits: account-label 41
- raw pattern hits: machine-hostname 6
- raw pattern hits: temp-path 416

## Classified hits

ACCEPTED	tree:c4f632e:evidence/wheelhouse-project-759/isolation-repro.txt:72:absolute-home-path	sha256-16:ecddbf5271e4b054	scrubbed retained evidence or command fixture, not a raw private path
ACCEPTED	tree:c4f632e:evidence/wheelhouse-project-fkk/full-suite-after.txt:331:absolute-home-path	sha256-16:df463feb539fbf2d	scrubbed retained evidence or command fixture, not a raw private path
ACCEPTED	tree:c4f632e:evidence/wheelhouse-project-fkk/preexisting-suite.txt:331:absolute-home-path	sha256-16:38fa3815fb260c22	scrubbed retained evidence or command fixture, not a raw private path
ACCEPTED	tree:c4f632e:evidence/wheelhouse-project-onp/isolation.selftest.log:72:absolute-home-path	sha256-16:5b7bd6e5eb09137f	scrubbed retained evidence or command fixture, not a raw private path
ACCEPTED	tree:c4f632e:generated/STARTUP.md.example:26:absolute-home-path	sha256-16:5f5042ac22bf6563	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:generated/STARTUP.md.example:26:absolute-home-path	sha256-16:e83022a48bf490df	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:seats/evidence-scrub.selftest.sh:20:absolute-home-path	sha256-16:44027969d682a9f0	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:evidence/wheelhouse-project-02ui/evidence.log:24:account-label	sha256-16:dc24cb36edf461c8	public specimen/example label or captured read of that example, not a live account secret
ACCEPTED	tree:c4f632e:evidence/wheelhouse-project-bf3/live2/transcript.jsonl:2835:account-label	sha256-16:16f524b314b611e2	public specimen/example label or captured read of that example, not a live account secret
ACCEPTED	tree:c4f632e:evidence/wheelhouse-project-bf3/live2/transcript.jsonl:2838:account-label	sha256-16:853d4f867eded577	public specimen/example label or captured read of that example, not a live account secret
ACCEPTED	tree:c4f632e:evidence/wheelhouse-project-bf3/live2/transcript.jsonl:2839:account-label	sha256-16:ac80a763f2e95e1d	public specimen/example label or captured read of that example, not a live account secret
ACCEPTED	tree:c4f632e:evidence/wheelhouse-project-bf3/live2/transcript.jsonl:2840:account-label	sha256-16:9951ad63b93981a2	public specimen/example label or captured read of that example, not a live account secret
ACCEPTED	tree:c4f632e:evidence/wheelhouse-project-bf3/live2/transcript.jsonl:3699:account-label	sha256-16:67bc1753a8ad30fd	public specimen/example label or captured read of that example, not a live account secret
ACCEPTED	tree:c4f632e:seats/README.md:48:account-label	sha256-16:0eded572f3873502	public specimen/example label or captured read of that example, not a live account secret
ACCEPTED	tree:c4f632e:seats/README.md:48:account-label	sha256-16:3c95cc35bffcb0ae	public specimen/example label or captured read of that example, not a live account secret
ACCEPTED	tree:c4f632e:seats/README.md:48:account-label	sha256-16:9333789ef1644174	public specimen/example label or captured read of that example, not a live account secret
ACCEPTED	tree:c4f632e:seats/README.md:48:account-label	sha256-16:fd26add1096ec682	public specimen/example label or captured read of that example, not a live account secret
ACCEPTED	tree:c4f632e:seats/README.md:50:account-label	sha256-16:2a5ab28c745ab381	public specimen/example label or captured read of that example, not a live account secret
ACCEPTED	tree:c4f632e:seats/README.md:50:account-label	sha256-16:4305429748db22cb	public specimen/example label or captured read of that example, not a live account secret
ACCEPTED	tree:c4f632e:seats/README.md:50:account-label	sha256-16:a007d89071345566	public specimen/example label or captured read of that example, not a live account secret
ACCEPTED	tree:c4f632e:seats/README.md:50:account-label	sha256-16:aa1a12747bdc828f	public specimen/example label or captured read of that example, not a live account secret
ACCEPTED	tree:c4f632e:seats/README.md:50:account-label	sha256-16:dad474b9ecc02b3b	public specimen/example label or captured read of that example, not a live account secret
ACCEPTED	tree:c4f632e:seats/README.md:51:account-label	sha256-16:12132f4facb1737a	public specimen/example label or captured read of that example, not a live account secret
ACCEPTED	tree:c4f632e:seats/README.md:51:account-label	sha256-16:1390e397f5d06588	public specimen/example label or captured read of that example, not a live account secret
ACCEPTED	tree:c4f632e:seats/README.md:51:account-label	sha256-16:26a535758a6e36b0	public specimen/example label or captured read of that example, not a live account secret
ACCEPTED	tree:c4f632e:seats/README.md:51:account-label	sha256-16:27c767540862c278	public specimen/example label or captured read of that example, not a live account secret
ACCEPTED	tree:c4f632e:seats/README.md:51:account-label	sha256-16:3188fdb6d7942855	public specimen/example label or captured read of that example, not a live account secret
ACCEPTED	tree:c4f632e:seats/README.md:51:account-label	sha256-16:31b77d4e46736d1e	public specimen/example label or captured read of that example, not a live account secret
ACCEPTED	tree:c4f632e:seats/README.md:51:account-label	sha256-16:341c7b09d8525a41	public specimen/example label or captured read of that example, not a live account secret
ACCEPTED	tree:c4f632e:seats/README.md:51:account-label	sha256-16:73562af26b49df98	public specimen/example label or captured read of that example, not a live account secret
ACCEPTED	tree:c4f632e:seats/README.md:51:account-label	sha256-16:8956ebd511106ded	public specimen/example label or captured read of that example, not a live account secret
ACCEPTED	tree:c4f632e:seats/README.md:51:account-label	sha256-16:98df9c40a10b7d99	public specimen/example label or captured read of that example, not a live account secret
ACCEPTED	tree:c4f632e:seats/README.md:52:account-label	sha256-16:42d75ac7bf13a53b	public specimen/example label or captured read of that example, not a live account secret
ACCEPTED	tree:c4f632e:seats/README.md:52:account-label	sha256-16:7a9a3fe8110dc8a6	public specimen/example label or captured read of that example, not a live account secret
ACCEPTED	tree:c4f632e:seats/README.md:52:account-label	sha256-16:be781956ecf6f101	public specimen/example label or captured read of that example, not a live account secret
ACCEPTED	tree:c4f632e:seats/README.md:52:account-label	sha256-16:ccc9c46eee54211e	public specimen/example label or captured read of that example, not a live account secret
ACCEPTED	tree:c4f632e:seats/seats.json.example:12:account-label	sha256-16:0bfe48326185cc7e	public specimen/example label or captured read of that example, not a live account secret
ACCEPTED	tree:c4f632e:seats/seats.json.example:12:account-label	sha256-16:1f1730ec247ae0f8	public specimen/example label or captured read of that example, not a live account secret
ACCEPTED	tree:c4f632e:seats/seats.json.example:12:account-label	sha256-16:344062e0b39833aa	public specimen/example label or captured read of that example, not a live account secret
ACCEPTED	tree:c4f632e:seats/seats.json.example:12:account-label	sha256-16:408c7d0b3a3ab6f0	public specimen/example label or captured read of that example, not a live account secret
ACCEPTED	tree:c4f632e:seats/seats.json.example:12:account-label	sha256-16:8a6a8ce41644d145	public specimen/example label or captured read of that example, not a live account secret
ACCEPTED	tree:c4f632e:seats/seats.json.example:12:account-label	sha256-16:ef71bdd5c8f9631c	public specimen/example label or captured read of that example, not a live account secret
ACCEPTED	tree:c4f632e:seats/seats.json.example:18:account-label	sha256-16:5c3ddfa5a8f0937b	public specimen/example label or captured read of that example, not a live account secret
ACCEPTED	tree:c4f632e:seats/seats.json.example:18:account-label	sha256-16:75c1cdd59577fd4d	public specimen/example label or captured read of that example, not a live account secret
ACCEPTED	tree:c4f632e:seats/seats.json.example:18:account-label	sha256-16:8b35c59172f30b89	public specimen/example label or captured read of that example, not a live account secret
ACCEPTED	tree:c4f632e:seats/seats.json.example:18:account-label	sha256-16:a8a8b8c5acc8bf95	public specimen/example label or captured read of that example, not a live account secret
ACCEPTED	tree:c4f632e:seats/seats.json.example:18:account-label	sha256-16:e508125513b5a47a	public specimen/example label or captured read of that example, not a live account secret
ACCEPTED	tree:c4f632e:seats/seats.json.example:18:account-label	sha256-16:f39513ed19f8abd5	public specimen/example label or captured read of that example, not a live account secret
ACCEPTED	tree:c4f632e:seats/fixtures/herald-panes/idle.txt:13:machine-hostname	sha256-16:49b70ef9a0f41ed0	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:seats/fixtures/herald-panes/idle.txt:15:machine-hostname	sha256-16:7b35babe4c135539	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:seats/fixtures/herald-panes/mid-turn-thinking.txt:13:machine-hostname	sha256-16:93b82f60cf18f4f2	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:seats/fixtures/herald-panes/mid-turn-thinking.txt:15:machine-hostname	sha256-16:66e425be24b5ed3e	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:seats/fixtures/herald-panes/tool-running.txt:13:machine-hostname	sha256-16:4622006ca54a8fb9	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:seats/fixtures/herald-panes/tool-running.txt:15:machine-hostname	sha256-16:c4f0284ab2412aaa	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:72:temp-path	sha256-16:ffabd49940604b59	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:73:temp-path	sha256-16:5b56995ad780c512	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:74:temp-path	sha256-16:5f317a18519a6a9e	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:77:temp-path	sha256-16:e63d418b8218f2d6	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:79:temp-path	sha256-16:266a40c4dd9d4867	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:92:temp-path	sha256-16:b8c36ea7bd60993c	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:93:temp-path	sha256-16:595a09740fb743b1	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:94:temp-path	sha256-16:94d23f05b58a8bcd	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:97:temp-path	sha256-16:e6b2728279fbf228	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:99:temp-path	sha256-16:4b8aca27e1537139	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:101:temp-path	sha256-16:ea522bc0168f5a3f	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:102:temp-path	sha256-16:254ef27ae2701e3d	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:103:temp-path	sha256-16:15a69a7090f0a0bb	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:106:temp-path	sha256-16:2692087c187ccf1d	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:106:temp-path	sha256-16:dd3780c762394082	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:107:temp-path	sha256-16:9d46726f1afd3695	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:108:temp-path	sha256-16:57a700ec5d0e83e0	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:108:temp-path	sha256-16:7b10e2b28a822bbd	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:111:temp-path	sha256-16:575d88e842ac943c	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:113:temp-path	sha256-16:70cebfcf5f160f2b	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:127:temp-path	sha256-16:5ce4e5b6975e31cf	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:128:temp-path	sha256-16:a96bad5c6cc4276b	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:129:temp-path	sha256-16:88350c32fa7997b5	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:132:temp-path	sha256-16:66d9b49f8eddd318	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:134:temp-path	sha256-16:e21fa0aef7bdb3d1	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:145:temp-path	sha256-16:a0e83c8c923258b2	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:146:temp-path	sha256-16:adbc70166959c4a6	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:147:temp-path	sha256-16:f921838cc38aad6f	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:150:temp-path	sha256-16:e06646df47d6d423	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:152:temp-path	sha256-16:41be4c0dd249afb5	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:152:temp-path	sha256-16:47e866b219286066	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:153:temp-path	sha256-16:4607bc245cc4d38d	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:154:temp-path	sha256-16:a49fd88d2e19e8f4	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:157:temp-path	sha256-16:f77b44a9d2d1950d	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:159:temp-path	sha256-16:86afccede4b20b46	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:160:temp-path	sha256-16:d60fda505de39ee6	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:161:temp-path	sha256-16:b036b5bfb90ec70c	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:162:temp-path	sha256-16:3fae0a9b63c8311f	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:164:temp-path	sha256-16:55a28fabed6158ee	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:164:temp-path	sha256-16:a9b1efcf91c4aea2	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:165:temp-path	sha256-16:43d858e45134c167	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:165:temp-path	sha256-16:66140503713c8c07	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:165:temp-path	sha256-16:8c2fd5e39c16faa3	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:166:temp-path	sha256-16:0e6fac3242f2b69f	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:166:temp-path	sha256-16:b4a1540a8aed26f6	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:167:temp-path	sha256-16:116b22afa1f2c046	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:169:temp-path	sha256-16:70bd6e0dc627d0b7	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:169:temp-path	sha256-16:d9b0e161bd04bc56	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:171:temp-path	sha256-16:4344637a52b6e1f8	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:171:temp-path	sha256-16:ceb7e1fd4fc9c196	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:176:temp-path	sha256-16:443d37ea59128862	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:177:temp-path	sha256-16:d1a6bfe0eb761ac5	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:178:temp-path	sha256-16:74f9a0dfaee95648	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:179:temp-path	sha256-16:0d7a0352e056f42a	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:179:temp-path	sha256-16:34281be6bcabeb48	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:179:temp-path	sha256-16:54f3ff45b01237d3	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:179:temp-path	sha256-16:d71dded9cc3c826a	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:180:temp-path	sha256-16:272ea5822b0e273f	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:180:temp-path	sha256-16:658af2f8e57cb286	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:180:temp-path	sha256-16:7d0f95805aa541ec	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:180:temp-path	sha256-16:b40e61cba6ac780b	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:180:temp-path	sha256-16:e74fe33e752d636f	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:181:temp-path	sha256-16:05bea55d9e98a992	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:181:temp-path	sha256-16:22e9109f6becacd2	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:181:temp-path	sha256-16:5346ce43fb739e24	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:181:temp-path	sha256-16:66810bd8ea414aed	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:181:temp-path	sha256-16:9c3b45a3daeaf1dd	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:181:temp-path	sha256-16:9f8376b7403f10d7	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:181:temp-path	sha256-16:e0d34bc8627d3ffa	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:182:temp-path	sha256-16:432b1bd86aa02341	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:182:temp-path	sha256-16:7da99c86436cfcf9	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:183:temp-path	sha256-16:15e2af57bdfbd60f	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:183:temp-path	sha256-16:2c39635f72bca2d2	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:184:temp-path	sha256-16:694b8af0392ddc8b	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:184:temp-path	sha256-16:bc0d8817d2324813	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:184:temp-path	sha256-16:c196b183308eebb2	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:184:temp-path	sha256-16:e233cd41b81abc38	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:185:temp-path	sha256-16:19c9c432c4a90b0f	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:186:temp-path	sha256-16:7f8145a916ad7c76	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:186:temp-path	sha256-16:86660bdd37672fad	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:186:temp-path	sha256-16:8e07837a040c7d1f	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:186:temp-path	sha256-16:b09a567e5dfd6062	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:186:temp-path	sha256-16:e8ddaec01d35e6f7	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:187:temp-path	sha256-16:d71a27f8d1cb91eb	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:188:temp-path	sha256-16:05f57992086c1909	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:188:temp-path	sha256-16:a9ed9702376be174	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:189:temp-path	sha256-16:28be64e18b0093e1	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:190:temp-path	sha256-16:f0b3f61bffcfaae1	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:192:temp-path	sha256-16:451bb3b6e658c48a	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:192:temp-path	sha256-16:4be9735301582a54	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:192:temp-path	sha256-16:65809c4a2c147296	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:192:temp-path	sha256-16:70cff715cc3f6439	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:193:temp-path	sha256-16:29138c0636ebefe2	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:193:temp-path	sha256-16:54d1abbd89de38b9	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:193:temp-path	sha256-16:54dee287211e40f0	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:193:temp-path	sha256-16:69308d06dc5cecc0	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:193:temp-path	sha256-16:7712c04ea0015c7e	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:194:temp-path	sha256-16:614eae12da85fb00	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:194:temp-path	sha256-16:6a977858de9d639b	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:194:temp-path	sha256-16:a739d9e34edbba0e	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:194:temp-path	sha256-16:fa37e2d663fff61f	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:195:temp-path	sha256-16:d5b5f76b9c44a7b8	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:197:temp-path	sha256-16:1994287462427164	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:197:temp-path	sha256-16:67965c22050b3c99	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:197:temp-path	sha256-16:97b824e0d3ec64d1	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:197:temp-path	sha256-16:b1e4a5b937be0c7b	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:199:temp-path	sha256-16:25b822c33a3d1562	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:199:temp-path	sha256-16:94c906ad838928f2	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:199:temp-path	sha256-16:9df73cec297f3b84	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:199:temp-path	sha256-16:c9a7fc0f76f1c3d0	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:201:temp-path	sha256-16:722a99c5a86fe6b1	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:202:temp-path	sha256-16:79e04cbca19a16f8	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:203:temp-path	sha256-16:0c55c65b4a6a8bc5	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:203:temp-path	sha256-16:a1739d307513a2d0	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:203:temp-path	sha256-16:ceb24b837b03834e	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:204:temp-path	sha256-16:4bb1bfe2879a63b1	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:204:temp-path	sha256-16:dea42a60bbe6f62d	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:205:temp-path	sha256-16:09904bb128e4da91	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:205:temp-path	sha256-16:58e9ee89beee8619	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:206:temp-path	sha256-16:a5d99cce1b941186	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:208:temp-path	sha256-16:5a6868785db082a5	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:208:temp-path	sha256-16:7e05e6dd06f1a8b3	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:208:temp-path	sha256-16:f50df06e5e7f3fdd	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:210:temp-path	sha256-16:b5da820e0b0f3dad	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:210:temp-path	sha256-16:cff80fa0c303f226	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:215:temp-path	sha256-16:1913e4b055ce8c9b	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:215:temp-path	sha256-16:24988851780b3439	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:215:temp-path	sha256-16:2731948f00734da2	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:215:temp-path	sha256-16:2f9073d5e2c51a9b	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:215:temp-path	sha256-16:a015877330f5e306	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:215:temp-path	sha256-16:b38ac2d33a93a4c6	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:216:temp-path	sha256-16:6f7d7d6cd155563e	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:216:temp-path	sha256-16:72df935b05bb2023	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:216:temp-path	sha256-16:79d48161bfd8bbd2	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:216:temp-path	sha256-16:7f97d44c0e9ca903	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:216:temp-path	sha256-16:bd85ddd812a11d54	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:216:temp-path	sha256-16:c2e6845dbbe1eb8f	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:217:temp-path	sha256-16:05fc556b87395328	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:217:temp-path	sha256-16:3f1e14f956bb6d92	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:217:temp-path	sha256-16:545cb89f2e6d0c05	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:217:temp-path	sha256-16:56bebad34d52cea1	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:217:temp-path	sha256-16:6ec097356b5242fc	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:217:temp-path	sha256-16:fdae204b95c3e059	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:220:temp-path	sha256-16:2a5c7716751f59a6	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:220:temp-path	sha256-16:31ccdbfee1886e2c	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:220:temp-path	sha256-16:485141d9f7f6463f	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:220:temp-path	sha256-16:61ca935e78df9cac	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:220:temp-path	sha256-16:8c804a457e86d74f	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:220:temp-path	sha256-16:ced20d0f487d054a	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:222:temp-path	sha256-16:5c7b2d8580d2732f	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:222:temp-path	sha256-16:770502686b03746a	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:222:temp-path	sha256-16:853e271653742554	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:222:temp-path	sha256-16:88aabbb8aa4f9637	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:222:temp-path	sha256-16:d74ef63d4e132f1f	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:222:temp-path	sha256-16:df78aa012a3a79aa	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:270:temp-path	sha256-16:0c12fe87d335db51	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:271:temp-path	sha256-16:4844109ee2e9b704	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:272:temp-path	sha256-16:5e69daabb591f41b	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:275:temp-path	sha256-16:19c4a123ab6d730f	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:277:temp-path	sha256-16:42aec4b4492f8f93	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:279:temp-path	sha256-16:99e5703cf75126a3	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:280:temp-path	sha256-16:66e7cc36a8bf4f88	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:281:temp-path	sha256-16:34e10a8ab87b0d69	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:284:temp-path	sha256-16:9fc70d52aecf6667	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:286:temp-path	sha256-16:db22ed7c72595a4d	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:292:temp-path	sha256-16:129360b03a318af7	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:292:temp-path	sha256-16:1779e8a20ede884d	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:292:temp-path	sha256-16:1eab948f8312ac75	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:292:temp-path	sha256-16:76d18ceb50db70ca	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:292:temp-path	sha256-16:c2192bbd747e5f33	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:292:temp-path	sha256-16:d2c368301f678787	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:293:temp-path	sha256-16:26bc5e77882b010f	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:293:temp-path	sha256-16:4a7c3241bc634355	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:293:temp-path	sha256-16:5d7034915dde6f4f	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:293:temp-path	sha256-16:7032ac2de6237545	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:293:temp-path	sha256-16:b002b54eb79deeba	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:293:temp-path	sha256-16:f515a3f54b11109a	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:294:temp-path	sha256-16:09f185d7e289ed95	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:294:temp-path	sha256-16:0d453387196ad4e7	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:294:temp-path	sha256-16:1146aad7f1a9dee7	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:294:temp-path	sha256-16:4621f1cdbbeae481	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:294:temp-path	sha256-16:64fe6a42ef48b492	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:294:temp-path	sha256-16:a908ea92c0172498	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:294:temp-path	sha256-16:c6e810715ceae3bd	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:294:temp-path	sha256-16:ce8622d85abd2078	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:295:temp-path	sha256-16:40e70fc339083c8f	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:295:temp-path	sha256-16:9c3e0ee7b77278e1	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:296:temp-path	sha256-16:189e04f5bd22e9b4	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:296:temp-path	sha256-16:33b171a7e92bbd51	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:297:temp-path	sha256-16:801831e3fdd96513	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:297:temp-path	sha256-16:84549453007d450b	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:297:temp-path	sha256-16:a28c646f9a8cf57b	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:297:temp-path	sha256-16:adf53fa588535afc	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:297:temp-path	sha256-16:eda386ff746dffb4	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:297:temp-path	sha256-16:f8a85a2c62d0604f	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:299:temp-path	sha256-16:11f2c75150a2ebac	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:299:temp-path	sha256-16:1954b5b6f3373283	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:299:temp-path	sha256-16:2822282df6875eb7	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:299:temp-path	sha256-16:517f9f919c804b18	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:299:temp-path	sha256-16:94db51aa24b7211f	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:299:temp-path	sha256-16:9a346bfdda031d1e	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:299:temp-path	sha256-16:bd4a1a0611a777f5	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:299:temp-path	sha256-16:e826294a4c50ef50	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:301:temp-path	sha256-16:1aef2bb3a3f2940e	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:301:temp-path	sha256-16:5cfe4f62d77e7697	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:301:temp-path	sha256-16:9a200644b8e557c5	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:302:temp-path	sha256-16:886c80e327c99bda	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:303:temp-path	sha256-16:6afb2255e84de1b7	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:306:temp-path	sha256-16:a060f82dfe732cc8	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:308:temp-path	sha256-16:be67f380dfd7a143	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:309:temp-path	sha256-16:fd8494364207934a	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:310:temp-path	sha256-16:c644918c0d5057f5	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:311:temp-path	sha256-16:48ae302b9c599c0b	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:314:temp-path	sha256-16:a5aeb7cd411dd30c	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:316:temp-path	sha256-16:e4c29d45dec97b82	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:320:temp-path	sha256-16:00036fe5cf79dd75	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:320:temp-path	sha256-16:307ef3877687ebee	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:320:temp-path	sha256-16:8148e6436b5d94ab	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:320:temp-path	sha256-16:fd87aa98c60390ac	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:321:temp-path	sha256-16:5bd053b503b76fb0	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:321:temp-path	sha256-16:805a12cb6c52f360	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:321:temp-path	sha256-16:8a6129e5cd2d5369	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:321:temp-path	sha256-16:ef018bd947229637	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:322:temp-path	sha256-16:38d2b88f832a9bc0	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:322:temp-path	sha256-16:7c829cda1bc909bc	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:322:temp-path	sha256-16:a41f731e81e4004f	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:322:temp-path	sha256-16:f00ec0bc49f7443a	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:325:temp-path	sha256-16:12fdf10aeb735450	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:325:temp-path	sha256-16:1934383b080930fc	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:325:temp-path	sha256-16:96ae7218b33ee812	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:325:temp-path	sha256-16:fb71fa1f4107ef3d	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:327:temp-path	sha256-16:2c770acbf5074ec6	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:327:temp-path	sha256-16:2cd0fb663e5222fe	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:327:temp-path	sha256-16:96a22f2b8c4ff6d6	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:327:temp-path	sha256-16:a7b36328b55191f1	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:329:temp-path	sha256-16:25d221cd847291ed	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:329:temp-path	sha256-16:e52adeed0bfeb5ff	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:329:temp-path	sha256-16:f10c036d856bb7c8	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:330:temp-path	sha256-16:32d730ce32a75188	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:330:temp-path	sha256-16:347aa44ff9cd5a10	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:330:temp-path	sha256-16:7b8c65e2a81e366d	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:331:temp-path	sha256-16:363ea642a894dc4c	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:331:temp-path	sha256-16:a60611f810dcb5f8	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:331:temp-path	sha256-16:b639de8566cc5174	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:334:temp-path	sha256-16:1591df80ccff164a	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:334:temp-path	sha256-16:4ff28f16fc333dd1	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:334:temp-path	sha256-16:cb6a415d2bc601ba	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:336:temp-path	sha256-16:a0ab2b3c2416c14c	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:336:temp-path	sha256-16:ceade4a81ab49ece	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:336:temp-path	sha256-16:fc87fd93d7a73cc1	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:341:temp-path	sha256-16:32caed30e60e86a4	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:342:temp-path	sha256-16:df597397fbcb3411	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:343:temp-path	sha256-16:d7730ee38ca7a006	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:346:temp-path	sha256-16:b87412e91967579f	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:348:temp-path	sha256-16:c7af0969f9be4edc	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:395:temp-path	sha256-16:025195df20a91c30	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:395:temp-path	sha256-16:2789d3f4971047c3	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:395:temp-path	sha256-16:6203717a8b51a212	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:395:temp-path	sha256-16:66aea7cc0d1e03cf	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:395:temp-path	sha256-16:840f9c39472166a0	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:395:temp-path	sha256-16:843b1837fe517794	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:395:temp-path	sha256-16:8a371cfecf12d120	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:395:temp-path	sha256-16:aab56c8f4ce1df15	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:395:temp-path	sha256-16:b3d3e20b22033718	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:395:temp-path	sha256-16:bc2cf70ece5f81be	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:395:temp-path	sha256-16:d1cc200dc4bdd60e	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:395:temp-path	sha256-16:d664e61c420cc036	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:395:temp-path	sha256-16:f215e3fc09279ae0	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:396:temp-path	sha256-16:012724fc97e0e18b	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:396:temp-path	sha256-16:34461722c2391b92	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:396:temp-path	sha256-16:355022c33a0bd6c8	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:396:temp-path	sha256-16:41d7c5b18194cdde	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:396:temp-path	sha256-16:4aee263a04b4e726	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:396:temp-path	sha256-16:6528208d7c8d83ab	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:396:temp-path	sha256-16:6c29edf026c329fa	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:396:temp-path	sha256-16:6e1cb77d0b84f676	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:396:temp-path	sha256-16:7db5d89a9fd7999d	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:396:temp-path	sha256-16:996350ddd7f3b037	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:396:temp-path	sha256-16:c7ae751cd0a0c9d8	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:396:temp-path	sha256-16:cebdf0e2fb9874cf	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:396:temp-path	sha256-16:d616e5961d133c0c	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:397:temp-path	sha256-16:02864a139467cc94	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:397:temp-path	sha256-16:0767bb4ce82b40c7	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:397:temp-path	sha256-16:13ea867164a0b871	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:397:temp-path	sha256-16:257652ec84a1447f	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:397:temp-path	sha256-16:3e2da05964bbb2c3	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:397:temp-path	sha256-16:5dfa1c5e1382b540	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:397:temp-path	sha256-16:8137a1f1f402152e	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:397:temp-path	sha256-16:82b871b2d7823d23	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:397:temp-path	sha256-16:9c022c5137768c81	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:397:temp-path	sha256-16:9fb1b61cfae0ee2a	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:397:temp-path	sha256-16:dbf15068b8b0db15	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:397:temp-path	sha256-16:dd3e9e3aa87d3197	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:397:temp-path	sha256-16:e649da165bcab711	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:400:temp-path	sha256-16:09560fb4429e5844	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:400:temp-path	sha256-16:12395a23bc3d2a07	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:400:temp-path	sha256-16:2c74f29ded78c6a1	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:400:temp-path	sha256-16:31e717a3c1588e12	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:400:temp-path	sha256-16:6ecc535a89d37b8d	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:400:temp-path	sha256-16:837f47fc97f04285	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:400:temp-path	sha256-16:ab662ef679c950d7	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:400:temp-path	sha256-16:aed02077472982d3	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:400:temp-path	sha256-16:b0ada5795e9ce300	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:400:temp-path	sha256-16:ba73fcfa4de10c22	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:400:temp-path	sha256-16:c4dc6bd52687e25c	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:400:temp-path	sha256-16:c9dd4ddd6ff8ee25	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:400:temp-path	sha256-16:f4acc76734b20f4a	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:402:temp-path	sha256-16:13db0ddd7b69372c	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:402:temp-path	sha256-16:14352961b3e90347	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:402:temp-path	sha256-16:1ab8c57e570655b9	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:402:temp-path	sha256-16:211bc0d9b8106b77	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:402:temp-path	sha256-16:2262e6764ea51521	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:402:temp-path	sha256-16:4f26fc057fd35355	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:402:temp-path	sha256-16:5a97e0e6d19f431b	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:402:temp-path	sha256-16:67d5cf926286d08e	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:402:temp-path	sha256-16:a5b2d6f0e842ab81	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:402:temp-path	sha256-16:aca9fa20fc43fc3f	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:402:temp-path	sha256-16:d8954cff80ba4ef8	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:402:temp-path	sha256-16:ec01385ac621132c	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:402:temp-path	sha256-16:fd7dab17a3dc28c7	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:408:temp-path	sha256-16:b8c4d27c886edb9e	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:408:temp-path	sha256-16:cf5e01386f095451	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:408:temp-path	sha256-16:d33af04cdca61950	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:409:temp-path	sha256-16:3d6916e1e75902f7	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:409:temp-path	sha256-16:830fc8380743b1c2	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:409:temp-path	sha256-16:db13c417e846fe73	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:409:temp-path	sha256-16:f26c6f2118b31685	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:410:temp-path	sha256-16:4b7bae560dcde910	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:410:temp-path	sha256-16:715c77fafbd0d058	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:410:temp-path	sha256-16:c66cfe133df7f8d6	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:410:temp-path	sha256-16:d7bcfd50fd01898b	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:411:temp-path	sha256-16:566054e1554e473a	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:413:temp-path	sha256-16:403d39f5e263a0f7	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:413:temp-path	sha256-16:4e5048d31531cb94	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:413:temp-path	sha256-16:98df486a99ca599c	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:414:temp-path	sha256-16:2f506641324864b3	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:415:temp-path	sha256-16:ab56c92ab9909c31	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:415:temp-path	sha256-16:d7f5f9caa8500f77	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:415:temp-path	sha256-16:fcdc1fec20c50a5c	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:416:temp-path	sha256-16:3efa18148a683070	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:417:temp-path	sha256-16:02658473dd0d7c7d	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:417:temp-path	sha256-16:4effae001ff59a2f	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:417:temp-path	sha256-16:83b04f5f58cbaa41	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:417:temp-path	sha256-16:8dceb765ae3bd648	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:417:temp-path	sha256-16:df0fa1eeaef75465	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:418:temp-path	sha256-16:4da121fddedf4452	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:418:temp-path	sha256-16:4f91b0860fa351eb	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:418:temp-path	sha256-16:94adef2e62366584	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:418:temp-path	sha256-16:b104c902237f1926	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:418:temp-path	sha256-16:efaebcb1c28e96f8	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:419:temp-path	sha256-16:1753787b7ab90cad	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:419:temp-path	sha256-16:5101dffbd9bd4542	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:419:temp-path	sha256-16:c4a3c6664b604d2d	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:419:temp-path	sha256-16:dd093734e19ccd2d	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:419:temp-path	sha256-16:f4c65d87315a829c	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:422:temp-path	sha256-16:077f84ece3a6ba14	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:422:temp-path	sha256-16:12727d324962bd27	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:422:temp-path	sha256-16:36ef3030e088aff1	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:422:temp-path	sha256-16:3810d2f52c19154a	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:422:temp-path	sha256-16:4a1da87b8d1fed2a	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:422:temp-path	sha256-16:558e27cdfbc8285f	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:422:temp-path	sha256-16:674ce3272d7ef305	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:422:temp-path	sha256-16:782c10e1b0574a46	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:422:temp-path	sha256-16:d0dddfadaaf4335d	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:422:temp-path	sha256-16:f34326322245caa7	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:423:temp-path	sha256-16:016f94fe7330811c	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:423:temp-path	sha256-16:614e755494703877	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:423:temp-path	sha256-16:959a401b55803721	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:423:temp-path	sha256-16:a30c91f629fae340	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:423:temp-path	sha256-16:cf7485ff1db83cf2	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:424:temp-path	sha256-16:2fca0fa476d7a5ca	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:424:temp-path	sha256-16:575c58f51ea706a3	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:424:temp-path	sha256-16:89fb7662f8a19dbc	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:424:temp-path	sha256-16:8a90df391e99364f	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:424:temp-path	sha256-16:8b1bb8039eb9fdbd	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:424:temp-path	sha256-16:bf09bd3a1da0f304	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:424:temp-path	sha256-16:dc608864f4033e74	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:424:temp-path	sha256-16:e36861f85dde8695	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:424:temp-path	sha256-16:efb9da868ed5d0df	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:424:temp-path	sha256-16:fda7f01aea0610a7	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:427:temp-path	sha256-16:019eb1edcccb32ff	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:427:temp-path	sha256-16:09be09e51d443475	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:427:temp-path	sha256-16:6b59f8846e93666a	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:427:temp-path	sha256-16:c777dc8528a41512	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:427:temp-path	sha256-16:eea3711c75e8df41	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:429:temp-path	sha256-16:1e4d8cdc1d7c8a59	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:429:temp-path	sha256-16:73431f8a9293e93a	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:429:temp-path	sha256-16:b5b9d99b2a925052	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:429:temp-path	sha256-16:be4731e87d5d691e	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:BOOTSTRAP.md:429:temp-path	sha256-16:f2e9be65f50a9007	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:README.md:26:temp-path	sha256-16:6ab3b77db420f9e2	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:README.md:26:temp-path	sha256-16:ea7c1dec9144bd75	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:contracts/GRAPH.md:21:temp-path	sha256-16:0899440c9aa34376	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:contracts/GRAPH.md:21:temp-path	sha256-16:3c07884b9046263a	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:contracts/GRAPH.md:21:temp-path	sha256-16:5f1bbae5a3b76729	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:contracts/GRAPH.md:23:temp-path	sha256-16:07bf850d73a5e795	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:contracts/GRAPH.md:23:temp-path	sha256-16:6d2257061aac0506	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:contracts/GRAPH.md:23:temp-path	sha256-16:858246b6bc6dc05a	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:contracts/GRAPH.md:23:temp-path	sha256-16:a436a6a3cf7f5e86	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:contracts/GRAPH.md:24:temp-path	sha256-16:03df7213d3c45e20	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:contracts/GRAPH.md:24:temp-path	sha256-16:883b116edc55362f	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:contracts/GRAPH.md:24:temp-path	sha256-16:b8445ef795813d3c	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:contracts/GRAPH.md:24:temp-path	sha256-16:ea280c7780281cc4	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:contracts/GRAPH.md:25:temp-path	sha256-16:4b1e543dc7c39dbb	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:evidence/wheelhouse-project-32v/clone-guard-capture.txt:8:temp-path	sha256-16:a1411153c5de7184	scrubbed retained evidence or command fixture, not a raw private path
ACCEPTED	tree:c4f632e:evidence/wheelhouse-project-32v/clone-guard-capture.txt:9:temp-path	sha256-16:ec0349f8f9a512f7	scrubbed retained evidence or command fixture, not a raw private path
ACCEPTED	tree:c4f632e:evidence/wheelhouse-project-32v/clone-guard-capture.txt:10:temp-path	sha256-16:ee294f74c6f2db9a	scrubbed retained evidence or command fixture, not a raw private path
ACCEPTED	tree:c4f632e:evidence/wheelhouse-project-50g/repro.txt:15:temp-path	sha256-16:71160e5851b58d2d	scrubbed retained evidence or command fixture, not a raw private path
ACCEPTED	tree:c4f632e:examples/android-cordova/BENCH.md:37:temp-path	sha256-16:55163d6a4e21173f	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:examples/android-cordova/BENCH.md:37:temp-path	sha256-16:912937c77c5f29d0	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:seats/evidence-scrub.selftest.sh:23:temp-path	sha256-16:c99ebd051b7f5258	public template prose/example, not a private identifier
ACCEPTED	tree:c4f632e:seats/evidence-scrub.selftest.sh:37:temp-path	sha256-16:a593232fee9ad951	public template prose/example, not a private identifier
ACCEPTED	tree:fab4906:evidence/wheelhouse-project-y7h/adapter-selftest.txt:2:temp-path	sha256-16:53e1b8370cd667c6	Keenan 2026-09-01 accepted fab4906 temp-path leak; do not scrub history
ACCEPTED	tree:fab4906:evidence/wheelhouse-project-y7h/adapter-selftest.txt:3:temp-path	sha256-16:294e1d6fdf7993d7	Keenan 2026-09-01 accepted fab4906 temp-path leak; do not scrub history
ACCEPTED	tree:fab4906:evidence/wheelhouse-project-y7h/adapter-selftest.txt:72:temp-path	sha256-16:0b31c6cd5d78e400	Keenan 2026-09-01 accepted fab4906 temp-path leak; do not scrub history
ACCEPTED	tree:fab4906:evidence/wheelhouse-project-y7h/adapter-selftest.txt:77:temp-path	sha256-16:0788db4061c53a86	Keenan 2026-09-01 accepted fab4906 temp-path leak; do not scrub history

summary: accepted=470 unaccepted=0
AUDIT RESULT: PASS — zero unaccepted findings.
