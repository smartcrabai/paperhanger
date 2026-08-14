import { describe, expect, test } from "bun:test";
import {
	fireEvent,
	render,
	screen,
	setupDashboardTest,
	userEvent,
} from "./test-setup";
import { TokenPrompt } from "./token-prompt";

setupDashboardTest();

describe("TokenPrompt", () => {
	test("keeps Continue disabled until a non-blank token is typed", async () => {
		const user = userEvent.setup();
		render(<TokenPrompt onSubmit={() => {}} />);

		const button = screen.getByRole("button", { name: "Continue" });
		expect(button).toBeDisabled();

		// Whitespace is not a token: the button must stay disabled.
		await user.type(screen.getByPlaceholderText("API token"), "   ");
		expect(button).toBeDisabled();

		await user.type(screen.getByPlaceholderText("API token"), "secret");
		expect(button).toBeEnabled();
	});

	test("submits the trimmed token", async () => {
		const user = userEvent.setup();
		const submitted: string[] = [];
		render(<TokenPrompt onSubmit={(value) => submitted.push(value)} />);

		await user.type(screen.getByPlaceholderText("API token"), "  secret  ");
		await user.click(screen.getByRole("button", { name: "Continue" }));

		expect(submitted).toEqual(["secret"]);
	});

	test("never submits a whitespace-only token", () => {
		const submitted: string[] = [];
		render(<TokenPrompt onSubmit={(value) => submitted.push(value)} />);

		// Typing "   " and pressing Enter would only prove the Continue
		// button's disabled guard works (Enter dispatches a click on that
		// button, and happy-dom drops clicks on disabled buttons before any
		// submit is requested) -- it never reaches handleSubmit. Fire the
		// submit event directly so this pins the handler's own trim check.
		fireEvent.change(screen.getByPlaceholderText("API token"), {
			target: { value: "   " },
		});
		fireEvent.submit(
			screen
				.getByRole("button", { name: "Continue" })
				.closest("form") as HTMLFormElement,
		);

		expect(submitted).toEqual([]);
	});

	test("renders the rejection reason when one is supplied", () => {
		render(<TokenPrompt onSubmit={() => {}} error="Token was rejected." />);

		expect(screen.getByText("Token was rejected.")).toBeInTheDocument();
	});

	test("masks the token input", () => {
		render(<TokenPrompt onSubmit={() => {}} />);

		expect(screen.getByPlaceholderText("API token")).toHaveAttribute(
			"type",
			"password",
		);
	});

	test("prevents the browser's native form submission", async () => {
		const user = userEvent.setup();
		render(<TokenPrompt onSubmit={() => {}} />);

		// A real browser navigates away on an unprevented submit, wiping all
		// SPA state. The Enter key reaches the native "submit" event before
		// React's own handler runs, so assert the event ends up defaulted.
		const submitDefaultPrevented = new Promise<boolean>((resolve) => {
			document.addEventListener(
				"submit",
				(event) => resolve(event.defaultPrevented),
				{ once: true },
			);
		});

		await user.type(screen.getByPlaceholderText("API token"), "secret{Enter}");

		expect(await submitDefaultPrevented).toBe(true);
	});

	test("refuses to submit when a raw submit event carries no token", () => {
		const submitted: string[] = [];
		render(<TokenPrompt onSubmit={(value) => submitted.push(value)} />);

		// Enter-key and click submission are already blocked by the disabled
		// button; fire the submit event directly (e.g. form.requestSubmit())
		// to prove the handler's own length check also refuses an empty
		// value, not just the disabled control.
		const form = screen
			.getByRole("button", { name: "Continue" })
			.closest("form") as HTMLFormElement;
		fireEvent.submit(form);

		expect(submitted).toEqual([]);
	});

	test("stays full-screen (no overlay class) when overlay is omitted", () => {
		const { container } = render(<TokenPrompt onSubmit={() => {}} />);

		expect(container.firstElementChild).toHaveClass("token-gate");
		expect(container.firstElementChild).not.toHaveClass("token-gate-overlay");
	});

	test("adds the token-gate-overlay class when rendered as an overlay", () => {
		const { container } = render(<TokenPrompt onSubmit={() => {}} overlay />);

		expect(container.firstElementChild).toHaveClass(
			"token-gate",
			"token-gate-overlay",
		);
	});

	test("has no Sign out button unless onSignOut is provided", () => {
		render(<TokenPrompt onSubmit={() => {}} />);

		// Without a handler there is nothing safe for it to do -- omitting the
		// button entirely keeps the first-run gate unchanged from before the
		// overlay was introduced.
		expect(
			screen.queryByRole("button", { name: "Sign out" }),
		).not.toBeInTheDocument();
	});

	test("renders and wires a Sign out button when onSignOut is provided", async () => {
		const user = userEvent.setup();
		const signOuts: number[] = [];
		render(
			<TokenPrompt onSubmit={() => {}} onSignOut={() => signOuts.push(1)} />,
		);

		await user.click(screen.getByRole("button", { name: "Sign out" }));

		expect(signOuts).toEqual([1]);
	});

	test("renders Continue as a direct child of .token-form on the first-run gate (no .form-actions wrapper)", () => {
		const { container } = render(<TokenPrompt onSubmit={() => {}} />);

		// .token-form is a column flexbox whose direct children stretch to its
		// 360px width; wrapping the lone Continue button in a row flexbox
		// collapses it to max-content, silently narrowing the first-run button.
		expect(container.querySelector(".form-actions")).toBeNull();
		expect(
			screen.getByRole("button", { name: "Continue" }).parentElement,
		).toHaveClass("token-form");
	});

	test("wraps the actions in .form-actions only once a Sign out button exists", () => {
		render(<TokenPrompt onSubmit={() => {}} onSignOut={() => {}} />);

		expect(
			screen.getByRole("button", { name: "Continue" }).parentElement,
		).toHaveClass("form-actions");
	});
});
