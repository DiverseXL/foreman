# Step 10 measurements

Sample sizes are small; differences are not statistically meaningful.

| Issue | Mode | n | Shipped k/n | Shipped and held-out passed k/n | tests_protected failed k/n | Mean attempts | Mean tokens | Mean gateway cost (USD) |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | graph | 3 | 0/3 | 0/3 | 0/3 | 1.67 | 10539 | 0.023347 |
| 1 | no-graph | 2 | 0/2 | 0/2 | 0/2 | 2.00 | 9406 | 0.020085 |
| 1 | unknown | 0 | 0/0 | 0/0 | 0/0 | n/a | n/a | n/a |
| 2 | graph | 3 | 1/3 | 1/3 | 0/3 | 1.67 | 11438 | 0.025698 |
| 2 | no-graph | 4 | 0/4 | 0/4 | 0/4 | 3.00 | 11100 | 0.031904 |
| 2 | unknown | 3 | 0/3 | 0/3 | 0/3 | 2.00 | 10566 | 0.027703 |
| 3 | graph | 0 | 0/0 | 0/0 | 0/0 | n/a | n/a | n/a |
| 3 | no-graph | 0 | 0/0 | 0/0 | 0/0 | n/a | n/a | n/a |
| 3 | unknown | 0 | 0/0 | 0/0 | 0/0 | n/a | n/a | n/a |

## Runs

| Run ID | Issue | Mode | Outcome | Attempts | Holdout | Tests protected failed | Tokens | Gateway cost (USD) | Wall seconds | Trace ID |
| --- | --- | --- | --- | ---: | --- | --- | ---: | ---: | ---: | --- |
| run-1791708715263 | 2 | graph | needs_human | 2 | n/a | false | 9649 | 0.026562 | 33.37 | 2be00f938c4d6dc87f1f6fb1fb38d410 |
| run-1791708752443 | 2 | graph | ready_to_ship | 2 | n/a | false | 18857 | 0.036413 | n/a | 358662f9bd277e7a2371d557d55f4296 |
| run-1791708792460 | 2 | graph | shipped | 1 | passed | false | 5808 | 0.014121 | 19.55 | 88f4a1c6263fd3978dd05a4674a89bbe |
| run-1791708815346 | 2 | no-graph | needs_human | 3 | n/a | false | 7844 | 0.026866 | 21.57 | 799c83e798fdf802305a67a2bad22a24 |
| run-1791708841707 | 2 | no-graph | needs_human | 3 | n/a | false | 10390 | 0.036038 | 24.60 | 3e3161408166aef6aaf3582b31188635 |
| run-1791707006483 | 2 | unknown | needs_human | 3 | n/a | false | 14444 | 0.038833 | 37.80 | 9aaa501e943ff4e16ec012c078ba4904 |
| run-1791707047236 | 2 | unknown | ready_to_ship | 1 | n/a | false | 7468 | 0.017544 | n/a | 7038b9ec493cbfd87b02028478e27895 |
| run-1791707084832 | 2 | unknown | needs_human | 2 | n/a | false | 9785 | 0.026732 | 22.78 | edbef9bd0acac3ada43d9486c9c7b0ce |
| run-1791707110608 | 2 | no-graph | needs_human | 3 | n/a | false | 19533 | 0.042550 | 38.24 | 112c6d367d6c775b0f9a52c7f55d950f |
| run-1791707151897 | 2 | no-graph | needs_human | 3 | n/a | false | 6633 | 0.022159 | 20.11 | d32fc74c9097f760c8b5ed167adf3a45 |
| run-1791728683996 | 1 | graph | needs_human | 2 | n/a | false | 10008 | 0.025742 | 56.95 | c5a16e2f3f8844c9b7b5049b1fea872f |
| run-1791728751992 | 1 | graph | needs_human | 2 | n/a | false | 9864 | 0.025182 | 50.15 | 427b2b68a1561e2407d8c9c954f6cbe4 |
| run-1791728811756 | 1 | graph | ready_to_ship | 1 | n/a | false | 11746 | 0.019118 | n/a | fbb0afa35462d32ee6f84e9228e0ff34 |
| run-1791728864982 | 1 | no-graph | needs_human | 2 | n/a | false | 7457 | 0.018427 | 27.15 | eff3394a20f7c982f7388470cb2cf239 |
| run-1791728898185 | 1 | no-graph | needs_human | 2 | n/a | false | 11354 | 0.021742 | 34.28 | 1227df5aca08139d4791773fecf67cc2 |

Stopped early: Ledger: Step 10 full-run cap reached. Runs 15 >= cap 15.
