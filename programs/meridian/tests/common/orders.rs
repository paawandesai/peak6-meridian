//! M1-05 helpers: `place_order`, `cancel_order`, `settle_funds`, `OpenOrders` and the escrow
//! conservation check (AC2). Kept apart from `mod.rs` so tickets do not collide on one file.

use anchor_lang::prelude::Pubkey;
use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};
use anchor_spl::token::spl_token;
use litesvm::types::TransactionResult;
use meridian::state::{Book, OpenOrders, OrderKind, Side, BASE_UNITS_PER_CENT, OPEN_ORDERS_SEED};
use solana_sdk::compute_budget::ComputeBudgetInstruction;
use solana_sdk::instruction::{AccountMeta, Instruction};
use solana_sdk::message::Message;
use solana_sdk::signature::{Keypair, Signer};
use solana_sdk::system_program;
use solana_sdk::transaction::Transaction;

use super::{config_pda, Harness, MarketAddresses, User};

/// The `OpenOrders` PDA of `owner` in `market`.
pub fn open_orders_pda(market: &Pubkey, owner: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[OPEN_ORDERS_SEED, market.as_ref(), owner.as_ref()],
        &meridian::ID,
    )
    .0
}

/// USDC base units of `qty` contracts at `price` cents.
pub fn notional(price: u8, qty: u64) -> u64 {
    u64::from(price) * BASE_UNITS_PER_CENT * qty
}

impl Harness {
    /// The stored `OpenOrders` of `owner`, if it was ever created.
    pub fn open_orders(&self, market: Pubkey, owner: Pubkey) -> Option<OpenOrders> {
        let account = self.svm.get_account(&open_orders_pda(&market, &owner))?;
        if account.data.is_empty() {
            // Never created (a transaction that merely listed the address leaves an empty
            // system account behind in LiteSVM).
            return None;
        }
        assert_eq!(account.owner, meridian::ID, "open orders is program-owned");
        Some(
            OpenOrders::try_deserialize(&mut account.data.as_slice())
                .expect("open orders deserialises"),
        )
    }

    /// Raw bytes of the book account, to assert a failed instruction changed nothing.
    pub fn book_data(&self, address: Pubkey) -> Vec<u8> {
        self.svm.get_account(&address).expect("book exists").data
    }

    /// `(free_usdc, free_yes, resting_count)` of `user`, zeros when never created.
    pub fn balances(&self, addresses: &MarketAddresses, user: &User) -> (u64, u64, u8) {
        self.open_orders(addresses.market, user.pubkey())
            .map_or((0, 0, 0), |oo| {
                (oo.free_usdc, oo.free_yes, oo.resting_count)
            })
    }

    /// Sends `instruction` after a compute-budget instruction raising the limit to `units`;
    /// the transaction's first signer pays.
    pub fn send_with_budget(
        &mut self,
        instruction: Instruction,
        signers: &[&Keypair],
        units: u32,
    ) -> TransactionResult {
        self.svm.expire_blockhash();
        let payer = signers.first().expect("a signer").pubkey();
        let message = Message::new(
            &[
                ComputeBudgetInstruction::set_compute_unit_limit(units),
                instruction,
            ],
            Some(&payer),
        );
        let tx = Transaction::new(signers, message, self.svm.latest_blockhash());
        self.svm.send_transaction(tx)
    }

    /// Asserts escrow conservation (M1-05 AC2) for `addresses`, given every user that ever
    /// traded in it:
    /// - escrow USDC = Σ resting bid notional + Σ free USDC credits,
    /// - escrow YES  = Σ resting ask qty + Σ free YES credits,
    /// - each owner's `resting_count` equals their orders on the book,
    /// - the vault invariants of M1-04 still hold.
    pub fn assert_escrow_conservation(&self, addresses: &MarketAddresses, users: &[&User]) {
        let book: Book = self.book(addresses.book);
        let bids = book.bids.iter().filter(|o| o.qty > 0);
        let asks = book.asks.iter().filter(|o| o.qty > 0);
        let bid_notional: u64 = bids.clone().map(|o| notional(o.price, o.qty)).sum();
        let ask_qty: u64 = asks.clone().map(|o| o.qty).sum();

        let (mut free_usdc, mut free_yes) = (0u64, 0u64);
        for user in users {
            let (usdc, yes, resting) = self.balances(addresses, user);
            free_usdc += usdc;
            free_yes += yes;
            let on_book = bids
                .clone()
                .chain(asks.clone())
                .filter(|o| o.owner == user.pubkey())
                .count();
            assert_eq!(
                usize::from(resting),
                on_book,
                "resting_count of {}",
                user.pubkey()
            );
        }
        let listed = users.len();
        let on_book_owners: std::collections::BTreeSet<Pubkey> =
            bids.clone().chain(asks.clone()).map(|o| o.owner).collect();
        assert!(
            on_book_owners.len() <= listed,
            "every order on the book belongs to a listed user"
        );
        assert_eq!(
            self.token_amount(addresses.escrow_usdc),
            bid_notional + free_usdc,
            "escrow USDC = resting bid notional + free USDC"
        );
        assert_eq!(
            self.token_amount(addresses.escrow_yes),
            ask_qty + free_yes,
            "escrow YES = resting ask qty + free YES"
        );
        self.assert_market_invariants(addresses);
    }
}

/// `place_order` for `user`; `makers` are the owners whose `OpenOrders` may be credited.
pub fn place_order_ix(
    user: &User,
    addresses: &MarketAddresses,
    side: Side,
    price: u8,
    qty: u64,
    kind: OrderKind,
    makers: &[Pubkey],
) -> Instruction {
    let mut accounts = meridian::accounts::PlaceOrder {
        config: config_pda(),
        market: addresses.market,
        book: addresses.book,
        user: user.pubkey(),
        open_orders: open_orders_pda(&addresses.market, &user.pubkey()),
        user_usdc: user.usdc,
        user_yes: user.yes,
        escrow_usdc: addresses.escrow_usdc,
        escrow_yes: addresses.escrow_yes,
        token_program: spl_token::ID,
        system_program: system_program::ID,
    }
    .to_account_metas(None);
    accounts.extend(
        makers
            .iter()
            .map(|owner| AccountMeta::new(open_orders_pda(&addresses.market, owner), false)),
    );
    Instruction {
        program_id: meridian::ID,
        accounts,
        data: meridian::instruction::PlaceOrder {
            side,
            price,
            qty,
            kind,
        }
        .data(),
    }
}

/// `cancel_order` signed by `owner` against `open_orders_of`'s balances.
pub fn cancel_order_ix(
    owner: &Pubkey,
    open_orders_of: &Pubkey,
    addresses: &MarketAddresses,
    order_id: u64,
) -> Instruction {
    Instruction {
        program_id: meridian::ID,
        accounts: meridian::accounts::CancelOrder {
            market: addresses.market,
            book: addresses.book,
            owner: *owner,
            open_orders: open_orders_pda(&addresses.market, open_orders_of),
        }
        .to_account_metas(None),
        data: meridian::instruction::CancelOrder { order_id }.data(),
    }
}

/// `settle_funds` signed by `owner` for `open_orders_of`, paying out to `destination`'s accounts.
pub fn settle_funds_ix(
    owner: &Pubkey,
    open_orders_of: &Pubkey,
    destination: &User,
    addresses: &MarketAddresses,
) -> Instruction {
    Instruction {
        program_id: meridian::ID,
        accounts: meridian::accounts::SettleFunds {
            market: addresses.market,
            owner: *owner,
            open_orders: open_orders_pda(&addresses.market, open_orders_of),
            escrow_usdc: addresses.escrow_usdc,
            escrow_yes: addresses.escrow_yes,
            user_usdc: destination.usdc,
            user_yes: destination.yes,
            token_program: spl_token::ID,
        }
        .to_account_metas(None),
        data: meridian::instruction::SettleFunds {}.data(),
    }
}

impl Harness {
    /// Sends `place_order` for `user`.
    #[allow(clippy::too_many_arguments)]
    pub fn place_order(
        &mut self,
        user: &User,
        addresses: &MarketAddresses,
        side: Side,
        price: u8,
        qty: u64,
        kind: OrderKind,
        makers: &[&User],
    ) -> TransactionResult {
        let owners: Vec<Pubkey> = makers.iter().map(|m| m.pubkey()).collect();
        self.send(
            place_order_ix(user, addresses, side, price, qty, kind, &owners),
            &[&user.keypair],
        )
    }

    /// Sends `cancel_order` for `user`'s own order.
    pub fn cancel_order(
        &mut self,
        user: &User,
        addresses: &MarketAddresses,
        order_id: u64,
    ) -> TransactionResult {
        self.send(
            cancel_order_ix(&user.pubkey(), &user.pubkey(), addresses, order_id),
            &[&user.keypair],
        )
    }

    /// Sends `settle_funds` for `user`'s own balances.
    pub fn settle_funds(&mut self, user: &User, addresses: &MarketAddresses) -> TransactionResult {
        self.send(
            settle_funds_ix(&user.pubkey(), &user.pubkey(), user, addresses),
            &[&user.keypair],
        )
    }
}

// ---- M1-06: buy_no / sell_no ------------------------------------------------------------------

fn no_path_accounts(
    user: &User,
    addresses: &MarketAddresses,
    makers: &[Pubkey],
) -> Vec<AccountMeta> {
    let mut accounts = meridian::accounts::BuyNo {
        config: config_pda(),
        market: addresses.market,
        book: addresses.book,
        user: user.pubkey(),
        open_orders: open_orders_pda(&addresses.market, &user.pubkey()),
        user_usdc: user.usdc,
        user_yes: user.yes,
        user_no: user.no,
        yes_mint: addresses.yes_mint,
        no_mint: addresses.no_mint,
        vault: addresses.vault,
        escrow_usdc: addresses.escrow_usdc,
        escrow_yes: addresses.escrow_yes,
        token_program: spl_token::ID,
        system_program: system_program::ID,
    }
    .to_account_metas(None);
    accounts.extend(
        makers
            .iter()
            .map(|owner| AccountMeta::new(open_orders_pda(&addresses.market, owner), false)),
    );
    accounts
}

/// `buy_no` with `price` = the YES price floor (100 − the NO limit).
pub fn buy_no_ix(
    user: &User,
    addresses: &MarketAddresses,
    qty: u64,
    price: u8,
    kind: OrderKind,
    makers: &[Pubkey],
) -> Instruction {
    Instruction {
        program_id: meridian::ID,
        accounts: no_path_accounts(user, addresses, makers),
        data: meridian::instruction::BuyNo { qty, price, kind }.data(),
    }
}

/// `sell_no` with `price` = the YES price cap (100 − the NO price accepted).
pub fn sell_no_ix(
    user: &User,
    addresses: &MarketAddresses,
    qty: u64,
    price: u8,
    makers: &[Pubkey],
) -> Instruction {
    Instruction {
        program_id: meridian::ID,
        accounts: no_path_accounts(user, addresses, makers),
        data: meridian::instruction::SellNo { qty, price }.data(),
    }
}

impl Harness {
    /// Sends `buy_no` for `user`.
    pub fn buy_no(
        &mut self,
        user: &User,
        addresses: &MarketAddresses,
        qty: u64,
        price: u8,
        kind: OrderKind,
        makers: &[&User],
    ) -> TransactionResult {
        let owners: Vec<Pubkey> = makers.iter().map(|m| m.pubkey()).collect();
        self.send(
            buy_no_ix(user, addresses, qty, price, kind, &owners),
            &[&user.keypair],
        )
    }

    /// Sends `sell_no` for `user`.
    pub fn sell_no(
        &mut self,
        user: &User,
        addresses: &MarketAddresses,
        qty: u64,
        price: u8,
        makers: &[&User],
    ) -> TransactionResult {
        let owners: Vec<Pubkey> = makers.iter().map(|m| m.pubkey()).collect();
        self.send(
            sell_no_ix(user, addresses, qty, price, &owners),
            &[&user.keypair],
        )
    }

    /// `(usdc, yes, no)` wallet balances of `user`.
    pub fn wallet(&self, user: &User) -> (u64, u64, u64) {
        (
            self.token_amount(user.usdc),
            self.token_amount(user.yes),
            self.token_amount(user.no),
        )
    }
}
