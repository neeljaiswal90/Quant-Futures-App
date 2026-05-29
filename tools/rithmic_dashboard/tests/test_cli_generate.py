from __future__ import annotations

from rithmic_dashboard.cli.generate import RETIREMENT_MESSAGE, main


def test_cli_generate_fails_loudly_when_called_directly(capsys) -> None:
    code = main(["--output-path", "data/dashboard/index.html", "--force"])

    captured = capsys.readouterr()
    assert code == 2
    assert RETIREMENT_MESSAGE in captured.err
    assert "v2 realtime dashboard" in captured.err


def test_cli_generate_does_not_accept_legacy_work(capsys) -> None:
    code = main(
        [
            "--analytics-root",
            "D:/Quant-futures-app/tools/rithmic_analytics",
            "--trading-date",
            "2026-05-29",
        ]
    )

    captured = capsys.readouterr()
    assert code != 0
    assert "V1 static HTML dashboard generator is retired" in captured.err
